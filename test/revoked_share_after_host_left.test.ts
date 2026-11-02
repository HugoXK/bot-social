// A share's room usage is the ledger of where the share seated the other owner's Bot. The host that brought that
// guest in ends its own seat when it leaves, never the guest's: only the guest's owner ends it, by revoking the
// share (or leaving with their own token). Ending the usage with the host's own leave makes the later revoke a
// no-op — the Bot stays readable in a room its share no longer reaches, and a line it holds can still be approved
// and delivered from a share that is gone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** A shares its Bot with B, and B opens a room bringing both Bots: A's Bot sits there as B's guest. */
async function guestInRoom(s: any, code: string) {
  const { A, B } = await friends(s.base);
  const share = await req(s.base, "POST", `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code, bots: [B.bot.id, A.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { A, B, roomId: joined.body.room_id as string, grantId: share.body.grant_id as string };
}

/** A line the guest's Bot leaves waiting in that room: a card for its own owner, nothing delivered yet. */
async function heldLine(s: any, roomId: string, A: any) {
  const d = await req(s.base, "POST", `/v1/face-rooms/${roomId}/messages`, A.owner.token, { bot_id: A.bot.id, text: "the guest's waiting line" });
  assert.equal(d.status, 202, JSON.stringify(d.body));
  return { approvalId: d.body.approval_id as string, messageId: d.body.message_id as string };
}

const revoke = (s: any, A: any, grantId: string) =>
  req(s.base, "DELETE", `/v1/bots/${A.bot.id}/grants/${grantId}`, A.owner.token);

const cardOf = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id) as any;

test("control: while the host is still in the room, revoking the share takes the guest out and settles its line", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, roomId, grantId } = await guestInRoom(s, "606211");
  const line = await heldLine(s, roomId, A);

  const revoked = await revoke(s, A, grantId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.ok((revoked.body.rooms_removed as string[]).includes(roomId), "the revoked share takes the guest out of the room");

  const gone = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(gone.status, 404, "the revoked guest can no longer read the room");
  const card = cardOf(s, line.approvalId);
  assert.equal(card.status, "cancelled", "the guest's held line is settled with the seat");
  assert.equal(card.decision, "room_left");
  const refused = await req(s.base, "POST", `/v1/approvals/${line.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(refused.status, 409, `a settled card is not a delivery: ${JSON.stringify(refused.body)}`);
});

test("the host leaving first must not turn the later revoke into a no-op", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, roomId, grantId } = await guestInRoom(s, "606212");
  const line = await heldLine(s, roomId, A);

  // The host walks out with its own Bot; the guest it brought stays, because only the guest's owner ends that seat.
  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, { bots: [B.bot.id] });
  assert.equal(left.status, 200, JSON.stringify(left.body));
  const seated = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(seated.status, 200, "the guest is still in the room");
  assert.ok((seated.body.members as any[]).some((m: any) => m.bot_id === A.bot.id), "the guest's seat is still there");

  const revoked = await revoke(s, A, grantId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.ok((revoked.body.rooms_removed as string[]).includes(roomId), "the share still seats the guest, so revoking it takes the guest out");

  const gone = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, A.owner.token);
  assert.equal(gone.status, 404, `the revoked guest can no longer read the room: ${JSON.stringify(gone.body)}`);

  const card = cardOf(s, line.approvalId);
  assert.equal(card.status, "cancelled", "the guest's held line is settled when its seat ends");
  assert.equal(card.decision, "room_left");

  const approved = await req(s.base, "POST", `/v1/approvals/${line.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(approved.status, 409, `a card behind a revoked share must not deliver: ${JSON.stringify(approved.body)}`);
});

test("another share's guest stays seated in its own room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B, roomId, grantId } = await guestInRoom(s, "606213");

  // A second owner shares its Bot with the same host, and it sits in a different room: that seat answers to its own
  // share, so nothing about the first share's revoke may move it.
  const C = await ownerWithBot(s.base, "carol");
  const rel = await C.owner.req("POST", "/v1/relationships", { from_bot_id: C.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await B.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  const share = await req(s.base, "POST", `/v1/bots/${C.bot.id}/grants`, C.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  const other = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "606214", bots: [B.bot.id, C.bot.id] });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const otherRoom = other.body.room_id as string;

  const left = await req(s.base, "POST", `/v1/face-rooms/${roomId}/leave`, B.owner.token, { bots: [B.bot.id] });
  assert.equal(left.status, 200, JSON.stringify(left.body));
  const revoked = await revoke(s, A, grantId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));

  const stillThere = await req(s.base, "GET", `/v1/face-rooms/${otherRoom}`, C.owner.token);
  assert.equal(stillThere.status, 200, `the other share's guest can still read its room: ${JSON.stringify(stillThere.body)}`);
  assert.ok((stillThere.body.members as any[]).some((m: any) => m.bot_id === C.bot.id), "the other share's guest keeps its seat");
  const seat = s.platform.db.prepare("SELECT left_at FROM face_room_members WHERE room_id = ? AND bot_id = ?").get(otherRoom, C.bot.id) as any;
  assert.equal(seat.left_at, null, "the other guest's seat was not ended by this revoke");
});
