// Console consistency (#18): owner-scoped audit chain, readable audit lines, time zones, naming and layout.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ownerWithBot, startServer } from "./helpers.js";
import { loadConsole, pub } from "./ui_helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

test("audit chain reports only the owner's own record count; no server-wide head or total", async () => {
  const A = await ownerWithBot(S.base, "auditA");
  const B = await ownerWithBot(S.base, "auditB");
  for (let i = 0; i < 3; i++) await B.owner.req("POST", "/v1/invites", { bot_id: B.bot.id, max_uses: 1, expires_in_hours: 1 });
  const a = await A.owner.req("GET", "/v1/audit-events?limit=1000");
  const total = S.platform.audit.verify().count;
  assert.equal(a.chain.ok, true);
  assert.deepEqual(Object.keys(a.chain).sort(), ["count", "ok"]);
  assert.equal(a.chain.count, a.events.length);
  assert.ok(a.chain.count < total, `owner count ${a.chain.count} should be below the server total ${total}`);
  const b = await B.owner.req("GET", "/v1/audit-events?limit=1000");
  assert.equal(b.chain.count, b.events.length);
  assert.ok(b.chain.count >= a.chain.count + 3);
});

test("fmt uses the owner's time zone with a short label, and falls back safely", () => {
  const { fmt, setTZ } = loadConsole(["fmt", "setTZ"]);
  setTZ("Asia/Shanghai");
  assert.equal(fmt("2026-10-19T00:21:00Z"), "19/10, 08:21 GMT+8");
  assert.equal(fmt("2026-10-19T00:21:00Z", { time: true }), "08:21 GMT+8");
  assert.equal(fmt("2026-10-19T00:21:00Z", { zone: false }), "19/10, 08:21");
  setTZ("Europe/Berlin");
  assert.match(fmt("2026-10-19T00:21:00Z"), /^19\/10, 02:21 (CEST|GMT\+2)$/);
  setTZ("Not/A_Zone"); // invalid → browser zone, never throws
  assert.match(fmt("2026-10-19T00:21:00Z"), /\d\d:\d\d \S+$/);
  assert.equal(fmt(null), "—");
});

test("audit lines are sentences; unknown actions fall back to the raw name", () => {
  const ui = loadConsole(["auditLine", "AUDIT_LABEL", "setMe: (m) => (me = m)"]);
  ui.setMe({ owner_id: "own_1", bots: [{ id: "bot_1", handle: "alice.bot" }] });
  assert.equal(ui.auditLine({ actor: "owner:own_1", action: "invite.revoked" }), "You revoked an invite link");
  assert.equal(ui.auditLine({ actor: "owner:own_1:mcp", action: "approval.decided" }), "You (through your assistant) decided an approval");
  assert.equal(ui.auditLine({ actor: "bot:bot_1", action: "conversation.created" }), "Your Bot @alice.bot started a chat");
  assert.equal(ui.auditLine({ actor: "bot:bot_9", action: "relationship.requested" }), "Another Bot sent a friend request");
  assert.equal(ui.auditLine({ actor: "platform", action: "approval.expired" }), "Bot Social closed an expired approval");
  assert.equal(ui.auditLine({ actor: "owner:own_1", action: "new.thing" }), "You · <code>new.thing</code>");
  for (const a of ["owner.registered", "bot.registered", "invite.created", "grant.revoked", "message.delivered", "connector_token.created"]) assert.ok(ui.AUDIT_LABEL[a], a);
});

test("copy and naming: Bot capitalized, plain login guidance, one product name for Connect", () => {
  const ui = pub("ui.js");
  for (const bad of ["My bots", "the bot ", "your bot ", "a bot ", "their bot ", "other bot ", "Join with bot", "register a bot", "Key kid", "<label>handle</label>", "botctl register</code> it prints", "Chain ${chain.count} records", "chain.head"]) {
    assert.ok(!ui.includes(bad), `ui.js still contains "${bad}"`);
  }
  assert.match(ui, /New here\? Register above, or ask your assistant to set you up/);
  assert.match(ui, /Advanced: Bot ID and signing keys/);
  assert.match(ui, /Advanced \(bring your own key\)/);
  assert.ok(!ui.includes('const TZ = "Asia/Shanghai"'), "no hard-coded time zone");
  assert.ok(!ui.includes('href="/connect" target="_blank"'), "Connect opens in the same tab");
  const connect = pub("connect.html");
  assert.ok(!connect.includes("Owner console"), "no 'Owner console' name");
  assert.ok(!/>Log out</.test(connect), "only the console sidebar has Log out");
  assert.match(connect, /<title>Connect your assistant · Bot Social<\/title>/);
  assert.match(connect, /← Back to Bot Social/);
  assert.ok(!connect.includes('slice(0,16).replace("T"," ")'), "token times are formatted with a zone label");
  const invite = pub("invite.html");
  assert.match(invite, /timeZoneName:"short"/);
  assert.ok(!invite.includes("invites your bot"));
});

test("layout: wider centered content, aligned Invites cards, no scrolling login page", () => {
  const html = pub("index.html");
  assert.match(html, /\.main\{[^}]*max-width:1280px;margin:0 auto\}/);
  assert.match(html, /\.grid\.fit\{grid-template-columns:repeat\(auto-fit,minmax\(310px,1fr\)\)\}/);
  assert.match(html, /\.login\{max-width:400px;margin:0 auto;padding:9vh 16px 24px\}/);
  assert.match(pub("ui.js"), /<div class="grid fit">\s*<div class="card"><b>Create an invite link<\/b>/);
});

test("calendar input is read in the owner's time zone", () => {
  const { setTZ, zonedToIso } = loadConsole(["setTZ", "zonedToIso"]);
  setTZ("Asia/Shanghai");
  assert.equal(zonedToIso("2026-10-21T10:00"), "2026-10-21T02:00:00.000Z");
  setTZ("Europe/Berlin");
  assert.equal(zonedToIso("2026-10-21T10:00"), "2026-10-21T08:00:00.000Z"); // CEST
  assert.equal(zonedToIso("2026-12-21T10:00"), "2026-12-21T09:00:00.000Z"); // CET
  // The hour the clocks skip in spring holds no moment of its own. Reading it as if it did would move the entry to a
  // different time than the owner typed, so the console refuses it; real times on both sides of the gap stay as they are.
  assert.equal(zonedToIso("2026-03-29T02:00"), null, "02:00 on the spring-forward day does not exist in Europe/Berlin");
  assert.equal(zonedToIso("2026-03-29T02:30"), null, "nor does 02:30");
  assert.equal(zonedToIso("2026-03-29T03:30"), "2026-03-29T01:30:00.000Z", "the time after the gap still reads back as itself");
  assert.equal(zonedToIso("2026-10-25T02:30"), "2026-10-25T01:30:00.000Z", "the repeated hour keeps the instant it picks today");
  setTZ("America/New_York");
  assert.equal(zonedToIso("2026-03-08T02:30"), null, "the same gap in a zone that skips 02:00–03:00");
  assert.equal(zonedToIso("2026-03-08T03:30"), "2026-03-08T07:30:00.000Z", "and the time just after it is read in the new offset");
  setTZ("UTC");
  assert.equal(zonedToIso("2026-10-21T10:00"), "2026-10-21T10:00:00.000Z");
  assert.equal(zonedToIso(""), null);
});

/** The My Bots page, which carries the calendar form, rendered from ui.js and talking to the test server. */
function calendarPage(base: string, token: string) {
  const src = readFileSync(join(here, "..", "public", "ui.js"), "utf8").replace(/\nboot\(\);\s*$/, "\n;globalThis.__ui = { PAGES };\n");
  const nodes = new Map<string, any>();
  const el = (sel: string) => {
    if (!nodes.has(sel)) nodes.set(sel, { sel, value: "", innerHTML: "", innerText: "", onclick: null, dataset: {}, style: {}, setAttribute() {}, removeAttribute() {}, closest: () => ({}) });
    return nodes.get(sel);
  };
  const posted: any[] = [];
  const ctx: any = {
    localStorage: { getItem: (k: string) => (k === "bs_owner_token" ? token : null), setItem() {}, removeItem() {} },
    window: { addEventListener() {} },
    document: {
      querySelector: (s: string) => el(s), querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }),
    },
    location: { hash: "#/bots", origin: "https://example.test", reload() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string, init?: any) => {
      if (init?.method === "POST" && path === "/v1/calendar/entries") posted.push(JSON.parse(init.body));
      return fetch(base + path, init);
    },
    setInterval() {}, setTimeout, clearTimeout, URLSearchParams, Intl, Date, console, confirm: () => true, prompt: () => null,
  };
  vm.runInNewContext(src, ctx);
  return {
    posted,
    /** Render the page and return its HTML; the calendar form's fields and its Add button are bound afterwards. */
    async render() { const v: any = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] }; await ctx.__ui.PAGES.bots(v); return v.innerHTML as string; },
    fill(start: string, end: string, title = "") { el("#cs").value = start; el("#ce").value = end; el("#ct").value = title; },
    add() { return el("#addcal").onclick(); },
    calerr: () => String(el("#calerr").innerHTML),
  };
}

test("the calendar form refuses a time the clocks skip instead of booking another time", async () => {
  const A = await ownerWithBot(S.base, "dstgap");
  const me = await A.owner.req("PATCH", "/v1/me", { timezone: "Europe/Berlin" });
  assert.equal(me.timezone, "Europe/Berlin", "the page must read the gap in the owner's zone");
  const page = calendarPage(S.base, A.owner.token);
  await page.render();

  // 02:30 on the spring-forward day is not a time in Berlin: the two clocks there read 01:59 and then 03:00.
  page.fill("2026-03-29T02:30", "2026-03-29T04:00", "Skipped hour");
  await page.add();

  assert.deepEqual(page.posted, [], "nothing is sent for a wall time that this zone does not have");
  const err = page.calerr();
  assert.match(err, /Europe\/Berlin/, `the form names the zone whose clocks skip that time: ${err}`);
  assert.match(err, /does not exist/, `and says the time does not exist: ${err}`);
  const { entries } = await A.owner.req("GET", "/v1/calendar/entries");
  assert.equal(entries.length, 0, "no entry was written");
});
