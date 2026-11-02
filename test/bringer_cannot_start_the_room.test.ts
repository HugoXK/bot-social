// A share that brought another home's Bot into a room is not a seat of your own. Starting the room voids the
// number that opened it, so only a home that sits in the room now may do it; a bringer who never took a seat
// gets the same non-member 404 every other door gives.
import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

async function room(t: any, code: string, bring: (bots: any) => string[]) {
  const s = await startServer({ faceRooms: { attemptsPerAccount: 50, attemptsPerIp: 200 } });
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const joined = await B.owner.req("POST", "/v1/face-rooms/join", { code, bots: bring({ A, B }) });
  return { s, A, B, roomId: joined.room_id as string };
}

test("a home that only brought another home's Bot in cannot start the room", async (t) => {
  // Bob brings Alice's Bot in and seats no Bot of his own: every seat in the room is Alice's.
  const { A, B, roomId } = await room(t, "818181", ({ A }) => [A.bot.id]);
  await expectApiError(B.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {}), 404, "face_room_not_found");
  // The refused start changed nothing: the room is still a candidate and the number still opens it.
  const still = await A.owner.req("GET", `/v1/face-rooms/${roomId}`);
  assert.equal(still.status, "candidate", "a refused start must not open the room");
  assert.equal(still.started_at, null, "a refused start must not mark the room started");
  // A home that does sit there still starts it, and that voids the number as before.
  const started = await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {});
  assert.equal(started.status, "open");
});

test("a home with a seat of its own starts the room", async (t) => {
  // Bob brings his own Bot and Alice's: Bob sits in the room, so the start is his to make.
  const { B, roomId } = await room(t, "828282", ({ A, B }) => [B.bot.id, A.bot.id]);
  const started = await B.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {});
  assert.equal(started.status, "open");
});

test("the brought guest's own home starts the room it was brought into", async (t) => {
  // Alice's Bot sits there even though Bob brought it: the seat is Alice's, so Alice may start the room.
  const { A, roomId } = await room(t, "838383", ({ A }) => [A.bot.id]);
  const started = await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {});
  assert.equal(started.status, "open");
});

test("the home that made the room starts it, and a second start is idempotent", async (t) => {
  const { A, roomId } = await room(t, "848484", ({ A }) => [A.bot.id]);
  assert.equal((await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {})).status, "open");
  assert.equal((await A.owner.req("POST", `/v1/face-rooms/${roomId}/start`, {})).status, "open");
});
