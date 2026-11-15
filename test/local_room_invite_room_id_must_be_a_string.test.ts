// `POST /v1/local-room-invites` names the room a ticket belongs to with `room_id`. On master 7491fbe1
// `mintLocalRoomInvite` opens with `String(body?.room_id ?? "").trim()` and only then judges the id's shape, so a
// truthy non-string is coerced and stored: an array is stored as its contents, `true` as "true", `7` as "7", and an
// object without a `toString` throws a `500 internal_error` on a body problem. Every other field in the same door
// already has its type gate (`bot_id`, `bot_handle`, `handle`, `name`); `room_id` has none.
// A room id in this body is a string or nothing: anything else is a 400 `invalid_request` naming the field, refused
// before the attempt record, the ticket row and the mint audit entry. Absent and null still fall through to the
// shape check, and every string keeps the check it already had, including the characters message for a malformed
// one. `{}` used to reach that characters message only because `String({})` is "[object Object]"; it is now refused
// by the type gate, with the same status.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";

const post = async (base: string, path: string, token: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

/** An owner with a FlyBot home and one member Bot, which is the inviter every mint here carries. */
async function homeOwner(s: any) {
  const p: any = s.platform;
  const fly: any = p.onboardFlybot({ display_name: "Wes" });
  const member = p.addHomeMember({ kind: "owner", ownerId: fly.owner_id }, fly.home.bot_id, { name: "writer" });
  const login = await fetch(s.base + "/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: fly.username, password: fly.generated_password }),
  });
  return { p, fly, member, token: ((await login.json()) as any).owner_token as string };
}

/** The three writes a refused room id must not leave behind: the ticket, the attempt record and the audit entry. */
function residue(p: any) {
  const one = (sql: string) => (p.get(sql) as any).n as number;
  return {
    invites: one("SELECT COUNT(*) n FROM local_room_invites"),
    attempts: one("SELECT COUNT(*) n FROM face_room_attempts"),
    minted: (p.audit.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'local_room.invite_minted'").get() as any).n as number,
  };
}

const mint = (s: any, token: string, body: Record<string, unknown>) => post(s.base, "/v1/local-room-invites", token, body);

const CHARS = "room_id: 1-64 chars [A-Za-z0-9._:-]";

test("a room id given as an array is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  const before = residue(p);
  const r = await mint(s, token, { room_id: ["loc-room-2"] });
  assert.equal(r.status, 400, `an array room id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
  assert.equal(r.body.error?.message, "room_id must be a string");
  assert.deepEqual(residue(p), before, "an array room id wrote no ticket, attempt or audit entry");
});

test("a room id given as a boolean is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  const before = residue(p);
  const r = await mint(s, token, { room_id: true });
  assert.equal(r.status, 400, `a boolean room id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
  assert.equal(r.body.error?.message, "room_id must be a string");
  assert.deepEqual(residue(p), before, "a boolean room id wrote no ticket, attempt or audit entry");
});

test("a room id given as a number is refused and writes nothing", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  const before = residue(p);
  const r = await mint(s, token, { room_id: 7 });
  assert.equal(r.status, 400, `a number room id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
  assert.equal(r.body.error?.message, "room_id must be a string");
  assert.deepEqual(residue(p), before, "a number room id wrote no ticket, attempt or audit entry");
});

test("a room id given as an object with no toString is a refusal, not a 500", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  const before = residue(p);
  const r = await mint(s, token, { room_id: { toString: null } });
  assert.equal(r.status, 400, `an object room id must be refused, not answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request", JSON.stringify(r.body));
  assert.equal(r.body.error?.message, "room_id must be a string");
  assert.deepEqual(residue(p), before, "an object room id wrote no ticket, attempt or audit entry");
});

test("the room id is judged before the Bot aliases and the link name", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  // The gate sits at the head of the door, so its refusal is the one reported even when the other fields are wrong too.
  for (const fields of [
    { room_id: 7, bot_id: [], name: {} },
    { room_id: ["loc-room-2"], bot_handle: {} },
    { room_id: { toString: null }, handle: 42 },
  ] as Record<string, unknown>[]) {
    const before = residue(p);
    const r = await mint(s, token, fields);
    assert.equal(r.status, 400, `${JSON.stringify(fields)} must be refused, not answered ${r.status}`);
    assert.equal(r.body.error?.code, "invalid_request");
    assert.equal(r.body.error?.message, "room_id must be a string");
    assert.deepEqual(residue(p), before, "a refused body writes nothing");
  }
});

test("the ways a room id is written and judged are unchanged", async (t) => {
  const s = await startServer(bulkAuth);
  t.after(s.stop);
  const { p, token } = await homeOwner(s);

  // A legal string still mints, and the ticket names the room the caller typed.
  for (const room of ["loc-room-1", "a".repeat(64), "Room_1.2:3-4"]) {
    const r = await mint(s, token, { room_id: room });
    assert.equal(r.status, 201, `a legal room id (${room.length} chars) still mints: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.room_id, room, `a legal room id (${room.length} chars) is named back`);
    assert.equal(p.get("SELECT room_id FROM local_room_invites ORDER BY rowid DESC LIMIT 1").room_id, room, `a legal room id (${room.length} chars) is stored`);
  }

  // Absent, null and every malformed string keep the characters message they already had.
  for (const [label, body] of [
    ["omitted", {}],
    ["null", { room_id: null }],
    ["empty", { room_id: "" }],
    ["blank", { room_id: "   " }],
    ["an inner space", { room_id: "has space" }],
    ["65 characters", { room_id: "a".repeat(65) }],
  ] as [string, Record<string, unknown>][]) {
    const before = residue(p);
    const r = await mint(s, token, body);
    assert.equal(r.status, 400, `${label} room id is still refused: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error?.code, "invalid_request", `${label} keeps the same code`);
    assert.equal(r.body.error?.message, CHARS, `${label} keeps the characters message`);
    assert.deepEqual(residue(p), before, `${label} room id writes nothing`);
  }

  // `{}` reached the characters message only through `String({})`; the type gate now names the field, same status.
  const before = residue(p);
  const r = await mint(s, token, { room_id: {} });
  assert.equal(r.status, 400, `{} room id is refused: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error?.code, "invalid_request");
  assert.equal(r.body.error?.message, "room_id must be a string");
  assert.deepEqual(residue(p), before, "a {} room id writes nothing");
});
