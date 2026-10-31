// A cancelled card is not pending any more, so the chat it was holding must stop saying it waits for one. That
// invariant lives in `refreshConversationStatus`: a chat with no pending card is `open`. Deciding a card and letting
// one expire both refresh it, but the paths that settle a card out from under the chat did not: a share ending, and
// the stale card an older build left pending behind a revoked grant. The owner's console then rendered "Pending
// approval" over an empty approval list, and the chat never came back until something else touched it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** The live share a grantor's owner gave that Bot: what a revoke acts on. */
const grantFor = (s: any, grantorOwner: string, granteeBot: string, capability = "chat.public") =>
  s.platform.db.prepare("SELECT id FROM grants WHERE grantor_owner = ? AND grantee_bot = ? AND capability = ? AND IFNULL(room_id, '') = '' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(grantorOwner, granteeBot, capability) as any;

const cardIn = async (base: string, owner: any, status: string, id: string) =>
  (((await req(base, "GET", `/v1/approvals?status=${status}`, owner.token)).body.approvals as any[]) ?? []).find((a) => a.approval_id === id) ?? null;

/** A line A's Bot holds for B: the card waits on A's owner, the chat is therefore waiting on a card. */
async function heldLine(A: any, B: any) {
  const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "hi" });
  const d: any = await A.bot.draftMessage(c.conversation_id, { text: "the line that must not land" });
  assert.equal(d.status, "pending_approval");
  return { cid: c.conversation_id as string, approvalId: d.approval_id as string };
}

const approve = (base: string, owner: any, id: string) =>
  req(base, "POST", `/v1/approvals/${id}/decision`, owner.token, { decision: "approved" });

const statusOf = async (A: any, cid: string) => (await A.bot.getConversation(cid)).status as string;

test("a held line settled by a revoked share leaves the chat open, not waiting", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    assert.equal(await statusOf(A, held.cid), "awaiting_approval", "the chat waits while the card is pending");

    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g, "B's owner gave A's Bot chat.public when they became friends");
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

    const settled: any = await cardIn(s.base, A.owner, "cancelled", held.approvalId);
    assert.ok(settled, "the held line is settled with the share it was waiting on");
    assert.equal(settled.decision, "grant_revoked");
    assert.equal(await statusOf(A, held.cid), "open", "nothing is pending, so the chat is not waiting for an approval");
  } finally { await s.stop(); }
});

test("a stale card refused at decision time leaves the chat open", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const g = grantFor(s, B.owner_id, A.bot.id);
    // The row an older build left behind: the share is gone, the card was never settled.
    s.platform.db.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ?").run(new Date().toISOString(), g.id);
    assert.equal(await statusOf(A, held.cid), "awaiting_approval");

    const refused: any = await approve(s.base, A.owner, held.approvalId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.ok(await cardIn(s.base, A.owner, "cancelled", held.approvalId), "the stale card is settled instead of delivered");
    assert.equal(await statusOf(A, held.cid), "open", "the chat stops waiting once the card it waited on is settled");
  } finally { await s.stop(); }
});

test("guard: the chat still says it waits while another card is pending", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "two lines" });
    const one: any = await A.bot.draftMessage(c.conversation_id, { text: "the first held line" });
    const two: any = await A.bot.draftMessage(c.conversation_id, { text: "the second held line" });
    assert.equal(one.status, "pending_approval");
    assert.equal(two.status, "pending_approval");
    assert.equal(await statusOf(A, c.conversation_id), "awaiting_approval");

    assert.equal((await approve(s.base, A.owner, one.approval_id)).status, 200);
    assert.equal(await statusOf(A, c.conversation_id), "awaiting_approval", "one card is still pending, so the chat still waits");
    assert.equal((await approve(s.base, A.owner, two.approval_id)).status, 200);
    assert.equal(await statusOf(A, c.conversation_id), "open", "with the last card decided the chat is open again");
  } finally { await s.stop(); }
});

test("guard: closing the chat is not undone by the cards settling", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const held = await heldLine(A, B);
    const closed: any = await req(s.base, "POST", `/v1/conversations/${held.cid}/close`, A.owner.token, { outcome: "abandoned" });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(await statusOf(A, held.cid), "closed");

    // A share ending sweeps the same pair afterwards; a closed chat is not a waiting one and cannot be re-opened by it.
    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);
    assert.equal(await statusOf(A, held.cid), "closed", "settling cards never reopens a chat its owner closed");
  } finally { await s.stop(); }
});

test("settling several cards in one chat leaves it open, and it is not left waiting after the first", async () => {
  const s = await startServer();
  try {
    const { A, B } = await friends(s.base);
    const c = await A.bot.startConversation(B.bot.id, { type: "general_chat", summary: "two lines, one share" });
    const one: any = await A.bot.draftMessage(c.conversation_id, { text: "the first line behind the share" });
    const two: any = await A.bot.draftMessage(c.conversation_id, { text: "the second line behind the share" });
    assert.equal(one.status, "pending_approval");
    assert.equal(two.status, "pending_approval");

    const g = grantFor(s, B.owner_id, A.bot.id);
    assert.ok(g);
    assert.equal((await req(s.base, "DELETE", `/v1/grants/${g.id}`, B.owner.token)).status, 200);

    const settledOne: any = await cardIn(s.base, A.owner, "cancelled", one.approval_id);
    const settledTwo: any = await cardIn(s.base, A.owner, "cancelled", two.approval_id);
    assert.equal(settledOne?.decision, "grant_revoked");
    assert.equal(settledTwo?.decision, "grant_revoked");
    assert.equal(await statusOf(A, c.conversation_id), "open", "every settled card is accounted for, so the chat is not waiting");
  } finally { await s.stop(); }
});
