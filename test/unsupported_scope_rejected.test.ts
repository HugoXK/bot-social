// P1 (#211): `scope` is a per-grant object that only `calendar.freebusy.read` reads (`src/platform.ts:2991` bounds
// the window by `window_days`, `:2992` turns `hours` into the hour rule; every other capability is matched by
// `findGrant` alone). It was nevertheless accepted and stored for any capability, at all three write points
// (`requestGrant` `src/platform.ts:1797`, `addGrant` `:1359`, and the target owner's acceptance at `consent`
// `:1182` → `writeActivation` `:1220–1225`), and the approval card renders it only for free/busy (`public/ui.js:284`).
// So for every other capability the owner approves a scope they cannot see and nothing enforces.
// A malformed free/busy scope was stored too: `parseHours` returning null (`src/platform.ts:2992`) simply added no
// hour rule, so `hours: "9-11"` silently granted every hour.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { friends, ownerWithBot, startServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES, setMe: (x) => { me = x; } };\n");

/** The console's Friends page — the only screen that lists a grant an owner wrote directly — against a real server. */
function loadFriendsPage(base: string, token: string) {
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }) },
    location: { hash: "#/friends", origin: "https://example.test" },
    fetch: (path: string, init?: any) => fetch(base + path, init),
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true,
  };
  vm.runInNewContext(src, ctx);
  return async (me: unknown) => {
    ctx.__ui.setMe(me);
    const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] };
    await ctx.__ui.PAGES.friends(v);
    return v.innerHTML as string;
  };
}

/** The owners' clients throw on a non-2xx answer; this keeps the status and the refusal text so a test can read them. */
async function attempt(p: Promise<any>) {
  try { return { ok: true as const, value: await p }; }
  catch (e: any) { return { ok: false as const, status: e.status as number, code: e.code as string, message: String(e.message) }; }
}

test("A: a grant request must not carry a scope its capability never reads", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await friends(base);
    const r = await attempt(p.B.bot.signed("/v1/grant-requests", "grant.request", {
      relationship_id: p.relId, capability: "chat.public", scope: { window_days: 14 }, reason: "planning the week",
    }));
    if (r.ok) assert.fail(`chat.public ignores scope, yet the request was accepted: ${JSON.stringify(r.value)}`);
    assert.equal(r.status, 400, "a scope nothing enforces is a bad request, not an owner decision");
    assert.equal(r.code, "invalid_request");
    assert.match(r.message, /scope is not supported for chat\.public/, "the refusal names the capability, so the Bot can fix it");
  } finally { await stop(); }
});

test("B: an owner's direct grant with a scope nothing reads is either refused or shown", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await friends(base);
    const r = await attempt(p.A.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "chat.public", scope: { window_days: 987 } }));
    const overview: any = await p.A.owner.req("GET", "/v1/friends-overview");
    const stored = (overview.friends || []).flatMap((f: any) => f.capabilities?.granted_to_peer || []).find((g: any) => g.scope?.window_days === 987);
    const html = await loadFriendsPage(base, p.A.owner.token)(await p.A.owner.req("GET", "/v1/me"));
    const shown = /987|window_days/.test(html);
    assert.ok(!r.ok || shown,
      `the write ${r.ok ? `was accepted and the grant stores ${JSON.stringify(stored?.scope)}` : `failed ${r.status}`}, ` +
      `but stored window_days never appears on the owner's page (shown=${shown})`);
    if (!r.ok) { assert.equal(r.status, 400); assert.match(r.message, /scope/); }
  } finally { await stop(); }
});

test("control: an empty scope and no scope at all stay accepted", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await friends(base);
    const empty = await attempt(p.A.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "chat.public", scope: {} }));
    assert.equal(empty.ok, true, `{} is the no-scope default every internal caller writes: ${JSON.stringify(empty)}`);
    const absent = await attempt(p.A.owner.req("POST", `/v1/relationships/${p.relId}/grants`, { capability: "profile.read" }));
    assert.equal(absent.ok, true, `a grant without the field is unchanged: ${JSON.stringify(absent)}`);
  } finally { await stop(); }
});

test("control: a real free/busy scope is still accepted, and still rendered on its request card", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await friends(base);
    const fb = await attempt(p.B.bot.signed("/v1/grant-requests", "grant.request", {
      relationship_id: p.relId, capability: "calendar.freebusy.read", scope: { window_days: 365, hours: "00:00-23:59" }, reason: "offsite planning",
    }));
    assert.equal(fb.ok, true, `free/busy is the capability that reads scope: ${JSON.stringify(fb)}`);
    const card = (await p.A.owner.req("GET", "/v1/approvals?status=pending")).approvals.find((a: any) => a.approval_id === (fb as any).value.approval_id);
    assert.ok(card, "the request is a pending approval");
    assert.deepEqual(card.grant_request.scope, { window_days: 365, hours: "00:00-23:59" }, "the scope reaches the card unchanged");
  } finally { await stop(); }
});

test("control: malformed free/busy values are refused, not silently widened", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await friends(base);
    const badDays = await attempt(p.B.bot.signed("/v1/grant-requests", "grant.request", {
      relationship_id: p.relId, capability: "calendar.freebusy.read", scope: { window_days: "14" }, reason: "x",
    }));
    if (badDays.ok) assert.fail(`window_days "14" is not a number, yet the request was accepted: ${JSON.stringify(badDays.value)}`);
    assert.equal(badDays.status, 400);
    assert.match(badDays.message, /window_days/);
    const badHours = await attempt(p.B.bot.signed("/v1/grant-requests", "grant.request", {
      relationship_id: p.relId, capability: "calendar.freebusy.read", scope: { hours: "9-11" }, reason: "x",
    }));
    if (badHours.ok) assert.fail(`hours "9-11" parses to no rule and grants every hour, yet it was accepted: ${JSON.stringify(badHours.value)}`);
    assert.equal(badHours.status, 400);
    assert.match(badHours.message, /hours/);
  } finally { await stop(); }
});

/** A request that waits for the target owner, so a test can accept it with `grant_capabilities`. */
async function pendingFriendship(base: string) {
  const A = await ownerWithBot(base, "alice");
  const B = await ownerWithBot(base, "bob");
  const rel = await A.owner.req("POST", "/v1/relationships", { from_bot_id: A.bot.id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  return { A, B, relId: rel.relationship_id as string };
}

test("C: an acceptance must not carry a scope its capability never reads", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await pendingFriendship(base);
    const r = await attempt(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, {
      decision: "accept", grant_capabilities: [{ capability: "chat.public", scope: { window_days: 987 } }],
    }));
    if (r.ok) {
      const row: any = (await p.B.owner.req("GET", "/v1/relationships")).relationships.find((x: any) => x.relationship_id === p.relId);
      const stored = [...(row?.capabilities?.me_on_peer ?? []), ...(row?.capabilities?.peer_on_me ?? [])].find((g: any) => g.scope?.window_days === 987);
      const html = await loadFriendsPage(base, p.B.owner.token)(await p.B.owner.req("GET", "/v1/me"));
      const shown = /987|window_days/.test(html);
      assert.fail(`the acceptance was taken and the grant stores ${JSON.stringify(stored?.scope)}, but stored window_days never appears on the owner's page (shown=${shown})`);
    }
    assert.equal(r.status, 400, "a scope nothing enforces is a bad request, not a friendship");
    assert.equal(r.code, "invalid_request");
    assert.match(r.message, /scope is not supported for chat\.public/, "the refusal names the capability, so the owner can fix it");
    const row: any = (await p.B.owner.req("GET", "/v1/relationships")).relationships.find((x: any) => x.relationship_id === p.relId);
    assert.equal(row.status, "pending_target", "a refused acceptance leaves the request waiting");
    assert.deepEqual(row.capabilities.me_on_peer, [], "nothing was granted to the requester");
    assert.deepEqual(row.capabilities.peer_on_me, [], "nothing was granted to the target");
  } finally { await stop(); }
});

test("control: accepting with a real free/busy scope still works, and the grant keeps it", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await pendingFriendship(base);
    const r = await attempt(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, {
      decision: "accept", grant_capabilities: [{ capability: "calendar.freebusy.read", scope: { window_days: 365, hours: "00:00-23:59" } }],
    }));
    assert.equal(r.ok, true, `free/busy is the capability that reads scope: ${JSON.stringify(r)}`);
    const row: any = (await p.B.owner.req("GET", "/v1/relationships")).relationships.find((x: any) => x.relationship_id === p.relId);
    assert.equal(row.status, "active");
    const g = row.capabilities.peer_on_me.find((x: any) => x.capability === "calendar.freebusy.read");
    assert.deepEqual(g.scope, { window_days: 365, hours: "00:00-23:59" }, "the accepted scope is stored unchanged");
  } finally { await stop(); }
});

test("control: accepting chat.public without a scope is unchanged", async () => {
  const { base, stop } = await startServer();
  try {
    const p = await pendingFriendship(base);
    const r = await attempt(p.B.owner.req("POST", `/v1/relationships/${p.relId}/consent`, {
      decision: "accept", grant_capabilities: [{ capability: "chat.public" }],
    }));
    assert.equal(r.ok, true, `a capability with no scope is the ordinary case: ${JSON.stringify(r)}`);
    const row: any = (await p.B.owner.req("GET", "/v1/relationships")).relationships.find((x: any) => x.relationship_id === p.relId);
    assert.equal(row.status, "active");
    const g = row.capabilities.peer_on_me.find((x: any) => x.capability === "chat.public");
    assert.deepEqual(g.scope, {}, "no scope still stores the empty object");
  } finally { await stop(); }
});
