/**
 * `calendar.accept_invite` names its invitation by `booking_id` and the caller's home only: neither door compares
 * the booking's other side with the peer of the conversation the card was drafted in. `calendar.book` refuses the
 * mirror mismatch in so many words ("attendees must be exactly the peer bot"); accept did not, so a Bot that read
 * the wrong booking id could answer another home's invitation inside a chat with a third home — and once approved
 * the platform flipped that invite to `confirmed` and told the third home a meeting was on (`event.invite_accepted`,
 * `trust: "platform"`), with the other homes' meeting window in its conversation read.
 *
 * A booking is made *with* the peer of the chat it was booked in, so the answer to it belongs there too. The two
 * sides of that binding are homes, not Bots: a home's other Bot may answer for the same home in the same chat.
 * Every door that can settle an accept asserts it before writing anything: the draft, an owner's `edited_params`,
 * and the execution itself (a card drafted by a build that did not check must not settle as an answer either).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { approveAll, bulkAuth, expectApiError, friends, ownerWithBot, startServer } from "./helpers.js";

const meetingIntent = () => ({ type: "schedule_meeting", summary: "plan the offsite" });

function window() {
  const s = Date.now() + 2 * 86400e3;
  return { start: new Date(s).toISOString(), end: new Date(s + 1800e3).toISOString() };
}

/** A and B are friends; C is a third home that is a friend of B and a stranger to A. */
async function threeHomes(t: any) {
  const s = await startServer({ ...bulkAuth });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const C = await ownerWithBot(s.base, "carol");
  const rel = await B.owner.req("POST", "/v1/relationships", { from_bot_id: B.bot.id, target_handle: C.handle, message: "hi", requested_capabilities: ["chat.public"] });
  await C.owner.req("POST", `/v1/relationships/${rel.relationship_id}/consent`, { decision: "accept", grant_capabilities: [] });
  return { s, A, B, C };
}

/** The organizer books a meeting with the invitee; returns the chat it was booked in and the invitation on the invitee's calendar. */
async function booked(organizer: any, invitee: any) {
  const cid = (await organizer.bot.startConversation(invitee.bot.id, meetingIntent())).conversation_id as string;
  const w = window();
  const d: any = await organizer.bot.draftAction(cid, "calendar.book", { title: "Offsite planning", start: w.start, end: w.end, attendees: [invitee.bot.id] }, "plan the offsite");
  assert.equal(d.status, "pending_approval");
  await approveAll(organizer.owner);
  const inv = ((await invitee.owner.req("GET", "/v1/calendar/entries")).entries as any[]).find((e) => e.status === "invited" && e.organizer_owner === organizer.owner_id);
  assert.ok(inv, "the invitee holds the invitation");
  return { cid, booking_id: inv.booking_id as string, start: inv.start as string, end: inv.end as string };
}

/** An unrelated chat between two homes that are friends. */
async function chatWith(bot: any, other: any, summary: string) {
  return (await bot.startConversation(other.id, { type: "general_chat", summary })).conversation_id as string;
}

const entriesOf = async (owner: any) => ((await owner.req("GET", "/v1/calendar/entries")).entries as any[]);
const inviteAccepted = async (bot: any) => ((await bot.events(0)).events as any[]).filter((e) => e.event_type === "event.invite_accepted");
const actionRow = (S: any, id: string) => S.platform.db.prepare("SELECT status, result, conversation_id FROM actions WHERE id = ?").get(id) as any;

test("a: an invitation cannot be answered in a chat with another home, and that home hears nothing", async (t) => {
  const { A, B, C } = await threeHomes(t);
  const b = await booked(A, B);
  const cidBC = await chatWith(B.bot, C.bot, "unrelated chat");

  // The invitee drafts the answer in a chat with a third home. The invitation is not that chat's to answer.
  await expectApiError(B.bot.draftAction(cidBC, "calendar.accept_invite", { booking_id: b.booking_id }, "accept the invite"), 404, "invite_not_found");

  // Nothing moved: no card, no approval, B still holds an unanswered invite, and C was never told anything.
  const seenByC = (await C.owner.req("GET", `/v1/conversations/${cidBC}`)).actions as any[];
  assert.equal(seenByC.length, 0, "the chat with C shows no card of B's");
  const pending = ((await B.owner.req("GET", "/v1/approvals?status=pending")).approvals as any[]).filter((a) => a.kind === "action");
  assert.equal(pending.length, 0, "a refused draft raises no approval card");
  assert.equal((await entriesOf(B.owner)).find((e) => e.booking_id === b.booking_id).status, "invited", "the invite is still waiting");
  assert.equal((await inviteAccepted(C.bot)).length, 0, "C is not told a meeting is on");
});

test("b: the chat the booking was made in still accepts, and only the organizer hears it", async (t) => {
  const { A, B, C } = await threeHomes(t);
  const b = await booked(A, B);

  const d: any = await B.bot.draftAction(b.cid, "calendar.accept_invite", { booking_id: b.booking_id }, "accept the invite");
  assert.equal(d.status, "pending_approval");
  await approveAll(B.owner);

  assert.equal((await entriesOf(B.owner)).find((e) => e.booking_id === b.booking_id).status, "confirmed", "the answer lands in the chat it belongs to");
  const accepted = (await inviteAccepted(A.bot)).find((e) => e.booking_id === b.booking_id);
  assert.ok(accepted, "the organizer is told the invite was accepted");
  assert.equal(accepted.by, B.bot.id);
  assert.equal(accepted.trust, "platform");
  // C is a stranger to this booking and stays one: no card in her chat, no event in her queue.
  assert.equal((await inviteAccepted(C.bot)).length, 0, "C hears nothing about A's and B's meeting");
});

test("c: the invitee's owner cannot retarget an accept at another home's booking", async (t) => {
  const { s, A, B, C } = await threeHomes(t);
  const ab = await booked(A, B);
  // A second invitation on B's calendar, from a home that is not the peer of B's chat with A.
  const cb = await booked(C, B);
  assert.notEqual(cb.booking_id, ab.booking_id, "the two bookings are distinct invitations on B's calendar");

  const d: any = await B.bot.draftAction(ab.cid, "calendar.accept_invite", { booking_id: ab.booking_id }, "accept the invite");
  assert.equal(d.status, "pending_approval");

  // An owner edit is not a new unchecked commitment: the door that refused the draft refuses the edit, and the
  // refusal leaves the card pending (not a consumed failure) and the other home's invite untouched.
  await expectApiError(B.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved_with_edits", edited_params: { booking_id: cb.booking_id } }), 404, "invite_not_found");
  const row = actionRow(s, d.action_id);
  assert.equal(row.status, "pending_approval", "a refused edit leaves the card pending");
  assert.equal(row.result, null, "a refused edit writes no result");
  assert.equal((await entriesOf(B.owner)).find((e) => e.booking_id === cb.booking_id).status, "invited", "the other home's invite is not consumed");
  assert.equal((await inviteAccepted(A.bot)).length, 0, "nothing is told to A either");

  // The same card, approved as drafted, still executes: the refusal did not eat the approval.
  const ok: any = await B.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  assert.equal(ok.status, "executed");
  assert.equal((await entriesOf(B.owner)).find((e) => e.booking_id === ab.booking_id).status, "confirmed");
});

test("d: a card that already sits in the wrong chat fails at execution instead of answering another invite", async (t) => {
  const { s, A, B, C } = await threeHomes(t);
  const b = await booked(A, B);
  const cidBC = await chatWith(B.bot, C.bot, "unrelated chat");

  // A card as a build without the peer check could have left it: drafted for this invitation, sitting in the chat
  // with C. The draft door would refuse it now, so the row is moved after the fact — the execution must not settle
  // it as an answer either.
  const d: any = await B.bot.draftAction(b.cid, "calendar.accept_invite", { booking_id: b.booking_id }, "accept the invite");
  assert.equal(d.status, "pending_approval");
  s.platform.db.prepare("UPDATE actions SET conversation_id = ? WHERE id = ?").run(cidBC, d.action_id);
  s.platform.db.prepare("UPDATE approvals SET conversation_id = ? WHERE id = ?").run(cidBC, d.approval_id);

  const done: any = await B.owner.req("POST", `/v1/approvals/${d.approval_id}/decision`, { decision: "approved" });
  assert.equal(done.status, "failed", "the card settles as a failure, not as an answer");
  assert.equal(done.reason, "invite_not_found");
  const row = actionRow(s, d.action_id);
  assert.equal(row.status, "failed");
  assert.equal((await entriesOf(B.owner)).find((e) => e.booking_id === b.booking_id).status, "invited", "the invite is not confirmed");
  assert.equal((await inviteAccepted(A.bot)).length, 0, "the organizer is not told a meeting is on");
  assert.equal((await inviteAccepted(C.bot)).length, 0, "the chat's own home is not told a meeting is on");
});
