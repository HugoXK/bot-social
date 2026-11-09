// A line written in a room opens a conversation whose door is that room (the `room` relationship). When the room
// ends, the thread keeps that relationship row, but the friendship is what settles it from then on: the delivery
// gate delivers a line that outlived its room for a pair that is also friends (#67), and the Bot's own draft door
// accepts a line there. The console, however, reads `room_id: null` once the room's grants are gone
// (`roomOfConversation`), so the chat page offers a composer -- and the send it makes names the conversation on
// screen, which the named-target door check refuses with 404 `conversation_not_found`. The owner is left reading a
// chat whose every reply fails, while the peer's Bot can still write into the very same thread.
//
// These tests pin the owner's side of that thread, and keep the doors it must not widen: a live room thread is still
// refused on the 1:1 route (its room decides it, and the console answers it from the room page), a dead room thread
// named under another room's door is still refused, and a seat pair with no friendship has no friendship door to
// settle on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const holdKey = (s: any, o: any) => s.platform.enableCustody(owner(o), o.bot.id, { private_key_pem: o.kp.privateKeyPem });
const ask = (base: string, method: string, path: string, token: string, body?: unknown) => fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

/** The owner's own credential, sent the way the console's composer sends it: one POST to the home send route. */
async function ownerSend(A: any, body: Record<string, unknown>) {
  const me = await A.owner.req("GET", "/v1/me");
  return A.owner.req("POST", `/v1/homes/${encodeURIComponent(me.home || A.bot.id)}/send`, body);
}

const lines = async (A: any, conversationId: string) =>
  (await A.owner.req("GET", `/v1/conversations/${conversationId}`)).messages as any[];

/** One home puts its Bot in a room it minted, and the other home claims a seat: a `room` relationship per pair. */
async function seated(s: any, A: any, B: any, room: string) {
  const minted = await A.owner.req("POST", "/v1/local-room-invites", { room_id: room, name: "Launch plan", bot_id: A.bot.id });
  const claimed = await ask(s.base, "POST", `/v1/local-room-invites/${encodeURIComponent(minted.ticket)}/claim`, B.owner.token, { bots: [B.bot.id] });
  assert.equal(claimed.status, 200, "the guest home claimed its seat");
  return { ticket: minted.ticket as string };
}

/** That home's seat ends: the room relationship stops being a room and its room-scoped grants go with it. */
const endSeat = (s: any, A: any, ticket: string, B: any) =>
  ask(s.base, "DELETE", `/v1/local-room-invites/${encodeURIComponent(ticket)}/claims/${encodeURIComponent(B.handle)}`, A.owner.token);

/** Two friends and one thread opened in a room whose seat has now ended. Returns the thread and the room id. */
async function threadAfterItsRoomEnded(s: any) {
  const ROOM = "session-4d5e6f70-8192-4a3b-9c4d-5e6f70819a2b";
  const { A, B } = await friends(s.base);
  holdKey(s, A); holdKey(s, B);
  const seat = await seated(s, A, B, ROOM);
  const sent = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "the line in the room", room_id: ROOM });
  assert.equal(sent.message.status, "delivered", "the room line was delivered while the room was live");
  const c = String(sent.conversation_id);
  assert.equal((await A.owner.req("GET", `/v1/conversations/${c}`)).room_id, ROOM, "while the room lives the thread names it");
  assert.equal((await endSeat(s, A, seat.ticket, B)).status, 204, "the guest's seat ended");
  return { A, B, c, room: ROOM };
}

test("the owner's console reply goes into a room conversation after its room ends", async () => {
  const s = await startServer();
  try {
    const { A, B, c, room } = await threadAfterItsRoomEnded(s);
    // The room door is really gone: a line that still names it is refused at that door.
    await expectApiError(ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "to the ended room", room_id: room }), 403, "room_not_shared");
    // What the console reads: still open, no room on it any more, and listed for both homes -- so its chat page
    // renders a composer for it.
    const view = await A.owner.req("GET", `/v1/conversations/${c}`);
    assert.equal(view.status, "open", "the thread is still open");
    assert.equal(view.room_id, null, "the thread no longer claims a room, which is what makes the console show a composer");
    assert.ok((await A.owner.req("GET", "/v1/conversations")).conversations.some((x: any) => x.conversation_id === c), "the owner's list still shows it");
    assert.ok((await B.owner.req("GET", "/v1/conversations")).conversations.some((x: any) => x.conversation_id === c), "and so does the peer's");
    // The reply the owner types on that page.
    const before = (await lines(A, c)).length;
    const r = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "the owner's answer", typed_by_owner: true, conversation_id: c });
    assert.equal(r.conversation_id, c, "the 202 names the conversation that was on screen");
    assert.equal(r.message.status, "delivered", "the owner's own line is delivered, not left waiting");
    const after = await lines(A, c);
    assert.equal(after.length, before + 1, "the thread gained exactly one line");
    assert.equal(after[after.length - 1].content.text, "the owner's answer", "and it is the owner's line");
    assert.equal(after[after.length - 1].typed_by_owner, true, "still marked as the owner's own words");
  } finally { await s.stop(); }
});

test("the peer's console reply goes into the same thread, from the other side", async () => {
  const s = await startServer();
  try {
    const { A, B, c } = await threadAfterItsRoomEnded(s);
    const before = (await lines(B, c)).length;
    const r = await ownerSend(B, { from_bot_id: B.bot.id, to: A.bot.id, text: "the peer's owner answers", typed_by_owner: true, conversation_id: c });
    assert.equal(r.conversation_id, c, "the 202 names the thread on the peer's screen");
    assert.equal((await lines(B, c)).length, before + 1, "the thread gained exactly one line");
    const inbound = (await lines(A, c)).filter((m: any) => m.direction === "inbound");
    assert.equal(inbound[inbound.length - 1].untrusted_content.text, "the peer's owner answers", "the other home reads it as the peer's line");
  } finally { await s.stop(); }
});

test("the Bot's own door already wrote into that thread, which is what makes the owner's refusal inconsistent", async () => {
  const s = await startServer();
  try {
    const { A, B, c } = await threadAfterItsRoomEnded(s);
    const draft = await B.bot.draftMessage(c, { text: "the peer Bot answers" });
    assert.equal(draft.status, "pending_approval", "the Bot's line is held for its owner");
    const done = await B.owner.req("POST", `/v1/approvals/${draft.approval_id}/decision`, { decision: "approved" });
    assert.equal(done.decision, "approved", "the card was decided");
    const after = await lines(A, c);
    assert.equal(after[after.length - 1].untrusted_content.text, "the peer Bot answers", "the line was delivered into the same thread");
  } finally { await s.stop(); }
});

test("a live room conversation is still refused on the 1:1 route", async () => {
  const s = await startServer();
  try {
    const ROOM = "session-5e6f7081-92a3-4b4c-8d5e-6f708192a3b4";
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    await seated(s, A, B, ROOM);
    const sent = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "still inside the room", room_id: ROOM });
    const c = String(sent.conversation_id);
    const before = (await lines(A, c)).length;
    await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "from the 1:1 page", typed_by_owner: true, conversation_id: c }),
      404,
      "conversation_not_found",
    );
    assert.equal((await lines(A, c)).length, before, "the live room's thread gained nothing");
    assert.equal((await A.owner.req("GET", `/v1/conversations/${c}`)).room_id, ROOM, "and it still names its room");
  } finally { await s.stop(); }
});

test("a dead room conversation named under another live room's door is still refused", async () => {
  const s = await startServer();
  try {
    const ENDED = "session-6f708192-a3b4-4c5d-9e6f-708192a3b4c5";
    const LIVE = "session-708192a3-b4c5-4d6e-8f70-8192a3b4c5d6";
    const { A, B } = await friends(s.base);
    holdKey(s, A);
    const endedSeat = await seated(s, A, B, ENDED);
    const ended = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "in the room that ends", room_id: ENDED });
    const cEnded = String(ended.conversation_id);
    assert.equal((await endSeat(s, A, endedSeat.ticket, B)).status, 204);
    await seated(s, A, B, LIVE);
    const live = await ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "in the room that stays", room_id: LIVE });
    const cLive = String(live.conversation_id);
    const before = (await lines(A, cEnded)).length;
    await expectApiError(
      ownerSend(A, { from_bot_id: A.bot.id, to: B.bot.id, text: "this belongs to the ended room", typed_by_owner: true, room_id: LIVE, conversation_id: cEnded }),
      404,
      "conversation_not_found",
    );
    assert.equal((await lines(A, cEnded)).length, before, "the ended room's thread gained nothing");
    assert.equal((await lines(A, cLive)).length, 1, "and the live room's thread gained nothing either");
  } finally { await s.stop(); }
});

test("a seat pair with no friendship has no friendship door for that thread", async () => {
  const s = await startServer();
  try {
    const ROOM = "session-8192a3b4-c5d6-4e7f-9a81-92a3b4c5d6e7";
    const A = await ownerWithBot(s.base, "ann");
    const B = await ownerWithBot(s.base, "ben");
    holdKey(s, A); holdKey(s, B);
    const seat = await seated(s, A, B, ROOM);
    const sent = await ownerSend(B, { from_bot_id: B.bot.id, to: A.bot.id, text: "hello from the room", room_id: ROOM });
    const c = String(sent.conversation_id);
    assert.equal((await endSeat(s, A, seat.ticket, B)).status, 204);
    const before = (await lines(B, c)).length;
    await expectApiError(
      ownerSend(B, { from_bot_id: B.bot.id, to: A.bot.id, text: "past the seat", typed_by_owner: true, conversation_id: c }),
      404,
      "conversation_not_found",
    );
    assert.equal((await lines(B, c)).length, before, "nothing was written");
  } finally { await s.stop(); }
});
