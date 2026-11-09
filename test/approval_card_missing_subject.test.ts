import assert from "node:assert/strict";
import { test } from "node:test";
import { friends, ownerWithBot, startServer } from "./helpers.js";

// `GET /v1/approvals` builds each card by reading the row it points at (`approvalCard`). Three of those reads
// dereference the row unconditionally — `outbound_message`, `relationship_request` and `invite` — so one card whose
// subject row was never written answers 500 for the owner's whole pending list. Those rows can go missing through a
// torn write: `draftMessage` and `draftFaceRoomMessage` write the card first and the row it points at second, with no
// transaction between them, so any refusal of the second statement leaves the first behind. No caller input can make
// the second statement fail; a store that refuses it can. These tests use the state (an orphan card inserted directly)
// and, separately, a store refusal of the row to prove the two writes are one — never a caller-shaped trigger.

const intent = { type: "general_chat", summary: "hello" };
const insertCard = (s: any, ownerId: string, id: string, kind: string, subjectId: string) =>
  s.platform.db.prepare("INSERT INTO approvals (id, owner_id, kind, subject_id, bot_id, conversation_id, summary, reasons, risk_flags, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ownerId, kind, subjectId, null, null, "a card whose subject row is gone", "[]", "[]", new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString());
const count = (s: any, table: "approvals" | "messages" | "face_room_drafts") =>
  (s.platform.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n as number;
const cards = async (owner: any, status = "pending") => (await owner.req("GET", `/v1/approvals?status=${status}`)).approvals as any[];

test("a card whose subject row was never written no longer takes the owner's pending list down", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, intent)).conversation_id as string;
  // A real card, so the queue has something to lose next to the orphans.
  await A.bot.draftMessage(cid, { text: "shall we sync this week?" });
  insertCard(s, A.owner_id, "apr_message_orphan", "outbound_message", "msg_never_written");
  insertCard(s, A.owner_id, "apr_relationship_orphan", "relationship_request", "rel_never_written");
  insertCard(s, A.owner_id, "apr_invite_orphan", "invite", "inv_never_written");

  const q = await cards(A.owner);
  assert.equal(q.length, 4, "every card is listed, the three orphans included");
  const orphan = (id: string) => q.find((x: any) => x.approval_id === id);
  assert.equal(orphan("apr_message_orphan").message, undefined, "a missing message row is left out, not dereferenced");
  assert.equal(orphan("apr_relationship_orphan").relationship, undefined, "a missing relationship row is left out");
  assert.equal(orphan("apr_invite_orphan").invite, undefined, "a missing invite row is left out");
  const real = q.find((x: any) => x.kind === "outbound_message" && x.approval_id !== "apr_message_orphan");
  assert.equal(real.message.status, "pending_approval", "the card next to them still reads");

  // Looking at the card settles nothing: it is still the owner's to decide.
  const again = await cards(A.owner);
  for (const id of ["apr_message_orphan", "apr_relationship_orphan", "apr_invite_orphan"]) {
    assert.equal(again.find((x: any) => x.approval_id === id).status, "pending", `${id}: reading the list changes nothing`);
  }
});

test("each such card is settled by id, with a named refusal instead of a 500", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const A = await ownerWithBot(s.base, "orph");
  insertCard(s, A.owner_id, "apr_message_orphan", "outbound_message", "msg_never_written");
  insertCard(s, A.owner_id, "apr_relationship_orphan", "relationship_request", "rel_never_written");
  insertCard(s, A.owner_id, "apr_invite_orphan", "invite", "inv_never_written");

  for (const id of ["apr_message_orphan", "apr_relationship_orphan", "apr_invite_orphan"]) {
    await assert.rejects(
      A.owner.req("POST", `/v1/approvals/${id}/decision`, { decision: "rejected" }),
      (e: any) => {
        assert.equal(e.status, 409, `${id}: a card whose row is gone must be a named 409, not a ${e.status} (${e.message})`);
        assert.equal(e.code, "invalid_state", id);
        return true;
      },
    );
  }
  const settled = await cards(A.owner, "all");
  for (const id of ["apr_message_orphan", "apr_relationship_orphan", "apr_invite_orphan"]) {
    assert.equal(settled.find((x: any) => x.approval_id === id).status, "cancelled", `${id}: the decision door cleared the card`);
  }
});

test("a message draft whose row the store refuses leaves no card behind", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const { A, B } = await friends(s.base);
  const cid = (await A.bot.startConversation(B.bot.id, intent)).conversation_id as string;
  const before = { approvals: count(s, "approvals"), messages: count(s, "messages") };

  // The second write of the draft, refused by the store. Stands in for any write the store will not take.
  s.platform.db.exec("CREATE TRIGGER refuse_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'store refused the message row'); END;");
  await assert.rejects(
    A.bot.draftMessage(cid, { text: "a line whose row the store refuses" }),
    (e: any) => {
      assert.equal(e.status, 500, `the store refusal still reaches the caller as a 500 (${e.message})`);
      return true;
    },
  );
  assert.equal(count(s, "messages"), before.messages, "the refused row wrote nothing");
  assert.equal(count(s, "approvals"), before.approvals, "and the card announced for it was rolled back with it");

  s.platform.db.exec("DROP TRIGGER refuse_message");
  assert.equal((await cards(A.owner)).length, 0, "the queue reads, and holds no card for the refused draft");
});

test("a face-room draft whose row the store refuses leaves no card behind", async (t) => {
  const s = await startServer(); t.after(s.stop);
  const A = await ownerWithBot(s.base, "fca");
  const B = await ownerWithBot(s.base, "fcb");
  const a: any = await A.owner.req("POST", "/v1/face-rooms/join", { code: "515151", bots: [A.bot.id] });
  await B.owner.req("POST", "/v1/face-rooms/join", { code: "515151", bots: [B.bot.id] });
  const roomId = a.room_id as string;
  const before = { approvals: count(s, "approvals"), drafts: count(s, "face_room_drafts") };

  s.platform.db.exec("CREATE TRIGGER refuse_face_draft BEFORE INSERT ON face_room_drafts BEGIN SELECT RAISE(ABORT, 'store refused the draft row'); END;");
  await assert.rejects(
    A.owner.req("POST", `/v1/face-rooms/${roomId}/messages`, { text: "a held room line", bot_id: A.bot.id }),
    (e: any) => {
      assert.equal(e.status, 500, `the store refusal still reaches the caller as a 500 (${e.message})`);
      return true;
    },
  );
  assert.equal(count(s, "face_room_drafts"), before.drafts, "the refused row wrote nothing");
  assert.equal(count(s, "approvals"), before.approvals, "and the card announced for it was rolled back with it");

  s.platform.db.exec("DROP TRIGGER refuse_face_draft");
  assert.equal((await cards(A.owner)).filter((x: any) => x.kind === "face_room_message").length, 0, "no card names the refused line");
});
