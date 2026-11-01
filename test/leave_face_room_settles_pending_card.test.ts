/**
 * A line waiting in a face room whose sender walks out of that room can never be approved: the decision door
 * answers `409 not_a_member`, the card stays pending until its 24-hour clock runs out, and until then the owner's
 * only way to clear it is to reject it. A seat ends through more than one door, so the card must be settled wherever
 * a seat ends: the Bot walking out, and a revoked share taking that Bot out of the room. Either way it is the same
 * "settle it, and tell the Bot that owned it" shape the revoke path already has — and nothing else: another
 * member's card, the same Bot's card in another room, and an action card elsewhere all keep their state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, inDays, ownerWithBot, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(1, 0), end: inDays(8, 23) } } });

async function req(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** Every owner joins one room by the same number; the last answer names it. */
async function room(base: string, code: string, ...owners: any[]) {
  let roomId = "";
  for (const o of owners) {
    const r = await req(base, "POST", "/v1/face-rooms/join", o.owner.token, { code, bots: [o.bot.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    roomId = r.body.room_id as string;
  }
  return roomId;
}

const draftLine = (base: string, roomId: string, o: any, text: string) =>
  req(base, "POST", `/v1/face-rooms/${roomId}/messages`, o.owner.token, { bot_id: o.bot.id, text });

const leave = (base: string, roomId: string, o: any) =>
  req(base, "POST", `/v1/face-rooms/${roomId}/leave`, o.owner.token, { bots: [o.bot.id] });

const approvalRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status, decision, decided_at FROM approvals WHERE id = ?").get(id) as any;
const draftRow = (s: any, id: string) =>
  s.platform.db.prepare("SELECT status FROM face_room_drafts WHERE id = ?").get(id) as any;
const decidedEvents = async (bot: any) =>
  ((await bot.events()).events as any[]).filter((e) => e.event_type === "approval.decided");

/** A held face-room line, ready to be walked out on. */
async function heldLine(s: any, roomId: string, o: any, text = "a line waiting for a decision") {
  const d = await draftLine(s.base, roomId, o, text);
  assert.equal(d.status, 202, JSON.stringify(d.body));
  assert.equal(d.body.status, "pending_approval");
  return { approvalId: d.body.approval_id as string, messageId: d.body.message_id as string };
}

test("leaving a room settles the waiting card of the Bot that left", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606071", A, B);
  const held = await heldLine(s, roomId, A);

  const out = await leave(s.base, roomId, A);
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const card = approvalRow(s, held.approvalId);
  assert.equal(card.status, "cancelled", "a line whose sender walked out is not a decision the owner can still make");
  assert.equal(card.decision, "room_left", "the settled card says why it was settled");
  assert.ok(card.decided_at, "the settled card records when it was settled");
  assert.equal(draftRow(s, held.messageId).status, "cancelled", "the draft behind the card is settled with it");

  // The room itself lives on for the member who stayed.
  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.ok(view.body.members.some((m: any) => m.bot_id === B.bot.id), "the member who stayed is still in the room");
});

test("and tells that Bot which line it was holding", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606072", A, B);
  const held = await heldLine(s, roomId, A);

  await leave(s.base, roomId, A);

  const mine = (await decidedEvents(A.bot)).filter((e) => e.approval_id === held.approvalId);
  assert.equal(mine.length, 1, "the Bot that owned the card hears the cancellation once, not silently");
  assert.equal(mine[0].kind, "face_room_message");
  assert.equal(mine[0].decision, "cancelled");
  assert.equal(mine[0].reason, "room_left");
  assert.equal(mine[0].message_id, held.messageId, "the event names the line it was holding");
});

test("another member's waiting card in the same room is left alone", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606073", A, B);
  const mine = await heldLine(s, roomId, A, "mine");
  const theirs = await heldLine(s, roomId, B, "theirs");

  await leave(s.base, roomId, A);

  assert.equal(approvalRow(s, theirs.approvalId).status, "pending", "leaving the room is not a decision about someone else's line");
  assert.equal(draftRow(s, theirs.messageId).status, "pending_approval");
  assert.equal(approvalRow(s, mine.approvalId).status, "cancelled", "only the card of the Bot that left is settled");
});

test("the same Bot's waiting card in another room is left alone", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const C = await ownerWithBot(s.base, "cat");
  const here = await room(s.base, "606074", A, B);
  const elsewhere = await room(s.base, "606075", A, C);
  const leaving = await heldLine(s, here, A, "the room I leave");
  const staying = await heldLine(s, elsewhere, A, "the room I stay in");

  await leave(s.base, here, A);

  assert.equal(approvalRow(s, staying.approvalId).status, "pending", "another room's line is not this room's business");
  assert.equal(draftRow(s, staying.messageId).status, "pending_approval");
  assert.equal(approvalRow(s, leaving.approvalId).status, "cancelled", "only the card waiting on the room that was left is settled");
});

test("an action card of the same Bot is left alone", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const roomId = await room(s.base, "606076", A, B);
  const line = await heldLine(s, roomId, A);
  const cid = (await A.bot.startConversation(B.bot.id, meetingIntent())).conversation_id as string;
  const booking: any = await A.bot.draftAction(cid, "calendar.book", { title: "Sync", start: inDays(3, 15), end: inDays(3, 15.5), attendees: [B.bot.id] });
  assert.equal(booking.status, "pending_approval");

  await leave(s.base, roomId, A);

  assert.equal(approvalRow(s, booking.approval_id).status, "pending", "a booking card is not a line in the room that was left");
  assert.equal(approvalRow(s, line.approvalId).status, "cancelled", "the room's own line is settled");
});

test("a revoked share that takes a guest out of the room settles that Bot's waiting card too", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  // A shares its Bot with B; B brings both Bots into one room, so A's Bot sits there as B's guest.
  const share = await req(s.base, "POST", `/v1/bots/${A.bot.id}/grants`, A.owner.token, { friend_bot_id: B.bot.id });
  assert.equal(share.status, 201, JSON.stringify(share.body));
  const joined = await req(s.base, "POST", "/v1/face-rooms/join", B.owner.token, { code: "606078", bots: [B.bot.id, A.bot.id] });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const roomId = joined.body.room_id as string;
  const guest = await heldLine(s, roomId, A, "the guest's waiting line");
  const host = await heldLine(s, roomId, B, "the host's waiting line");

  const revoked = await req(s.base, "DELETE", `/v1/bots/${A.bot.id}/grants/${share.body.grant_id}`, A.owner.token);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.ok((revoked.body.rooms_removed as string[]).includes(roomId), "the revoked share takes the guest out of the room");

  const card = approvalRow(s, guest.approvalId);
  assert.equal(card.status, "cancelled", "a guest taken out of the room is not a decision its owner can still make");
  assert.equal(card.decision, "room_left", "the settled card says why it was settled");
  assert.equal(draftRow(s, guest.messageId).status, "cancelled", "the draft behind the card is settled with it");
  assert.equal(approvalRow(s, host.approvalId).status, "pending", "the card of the member who stayed is not this share's business");

  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.ok(!(view.body.members as any[]).some((m: any) => m.bot_id === A.bot.id), "the guest's seat ended with the share");
});

test("a member who stays can still be approved and delivered in that room", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "ann");
  const B = await ownerWithBot(s.base, "ben");
  const roomId = await room(s.base, "606077", A, B);
  const held = await heldLine(s, roomId, A, "still goes out");

  const decided = await req(s.base, "POST", `/v1/approvals/${held.approvalId}/decision`, A.owner.token, { decision: "approved" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));

  assert.equal(approvalRow(s, held.approvalId).status, "approved");
  assert.equal(draftRow(s, held.messageId).status, "delivered");
  const view = await req(s.base, "GET", `/v1/face-rooms/${roomId}`, B.owner.token);
  assert.ok((view.body.events as any[]).some((e: any) => e.type === "room.message"), "the line reached the room");
});
