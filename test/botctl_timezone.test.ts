// botctl prints times in the owner's own time zone — owners.timezone, the field the console formats with — instead of
// one fixed zone: calendar, free/busy and the schedule_meeting intent all follow GET /v1/me. A server that cannot say
// the zone leaves the run in a named UTC rather than a silent default, and the zone is asked for once per run.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
after(async () => { await S?.stop(); });

async function api(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(S.base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

/** A fresh $BOTSOCIAL_HOME so each case registers into its own config directory. */
function cli() {
  const dir = mkdtempSync(join(tmpdir(), "botctl-tz-"));
  const home = join(dir, ".bot-social");
  mkdirSync(home, { recursive: true });
  const run = (...a: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/botctl.ts", ...a], { env: { ...process.env, BOTSOCIAL_HOME: home, BOTSOCIAL_URL: "" }, encoding: "utf8" });
  const cfg = (name: string) => JSON.parse(readFileSync(join(home, `${name}.json`), "utf8"));
  const saveCfg = (name: string, c: unknown) => writeFileSync(join(home, `${name}.json`), JSON.stringify(c, null, 2));
  return { home, run, cfg, saveCfg };
}

/** A server in front of the real one that fails GET /v1/me, to see where an unanswerable zone leaves the output. */
async function meFails(base: string) {
  let hits = 0;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (req.method === "GET" && req.url === "/v1/me") {
        hits++;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal_error", message: "the owner store is down" } }));
        return;
      }
      const r = await fetch(base + req.url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, stop: () => new Promise<void>((r) => srv.close(() => r())) };
}

const T = cli();
let A: any, B: any, cid: string;

before(async () => {
  S = await startServer();
  await T.run("register", "anna", "--url", S.base);
  await T.run("register", "ben", "--url", S.base);
  A = T.cfg("anna");
  B = T.cfg("ben");
  const me = await api("PATCH", "/v1/me", A.owner_token, { timezone: "Europe/Berlin" });
  assert.equal(me.body.timezone, "Europe/Berlin", "the owner's zone is a real setting, not a guess");
  const rel = await api("POST", "/v1/relationships", A.owner_token, { from_bot_id: A.bot_id, target_handle: B.handle, message: "hi", requested_capabilities: ["chat.public"] });
  assert.equal(rel.status, 201, JSON.stringify(rel.body));
  const consent = await api("POST", `/v1/relationships/${rel.body.relationship_id}/consent`, B.owner_token, {
    decision: "accept", grant_capabilities: [{ capability: "calendar.freebusy.read", scope: { window_days: 14, hours: "09:00-18:00" } }],
  });
  assert.equal(consent.status, 200, JSON.stringify(consent.body));
  // A 12:00–13:00 UTC meeting: 13:00–14:00 in Berlin, 20:00–21:00 in Asia/Shanghai.
  const add = await api("POST", "/v1/calendar/entries", A.owner_token, { start: "2026-03-01T12:00:00.000Z", end: "2026-03-01T13:00:00.000Z", title: "Sync" });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const started = JSON.parse((await T.run("start", "anna", B.handle, "--intent", "schedule_meeting", "--json")).stdout);
  cid = started.conversation_id;
});

test("calendar times are printed in the owner's zone, and the zone is named", async () => {
  const out = await T.run("calendar", "anna");
  assert.match(out.stdout, /13:00/, `the owner in Berlin reads 13:00 for a 12:00 UTC meeting, not another zone's hour: ${out.stdout}`);
  assert.match(out.stdout, /14:00/, "and the end of the meeting follows the same zone");
  assert.doesNotMatch(out.stdout, /20:00/, `one fixed zone would have printed 20:00: ${out.stdout}`);
  assert.match(out.stdout, /GMT\+1|CET|Berlin/, `the printed time says which zone it is in: ${out.stdout}`);
});

test("the schedule_meeting intent carries the owner's zone, not one fixed zone", async () => {
  const v = await (await fetch(`${S.base}/v1/conversations/${cid}`, { headers: { authorization: `Bearer ${A.bot_token}` } })).json() as any;
  assert.equal(v.intent.type, "schedule_meeting");
  assert.equal(v.intent.params.timezone, "Europe/Berlin", "the meeting window is computed in the owner's zone");
});

test("free/busy answers are printed in the owner's zone too", async () => {
  const out = await T.run("freebusy", "anna", cid, "--start", "2026-03-01T00:00:00Z", "--end", "2026-03-02T00:00:00Z");
  assert.match(out.stdout, /13:00/, `a busy 12:00–13:00 UTC block reads 13:00–14:00 in Berlin: ${out.stdout}`);
  assert.doesNotMatch(out.stdout, /20:00/, `not 20:00 from a fixed zone: ${out.stdout}`);
  assert.match(out.stdout, /GMT\+1|CET|Berlin/, `the busy interval names its zone: ${out.stdout}`);
});

test("a zone the server will not tell stays a named UTC, asked for once", async () => {
  const proxy = await meFails(S.base);
  try {
    T.saveCfg("anna-proxy", { ...A, name: "anna-proxy", base: proxy.url });
    const out = await T.run("calendar", "anna-proxy");
    assert.match(out.stdout, /12:00/, `the entry is shown at its UTC hour: ${out.stdout}`);
    assert.match(out.stdout, /UTC/, `and says so instead of quietly using another zone: ${out.stdout}`);
    assert.doesNotMatch(out.stdout, /20:00/, `never a silent Shanghai time: ${out.stdout}`);
    assert.equal(proxy.hits(), 1, "the zone is fetched once per run, not once per printed time");
  } finally { await proxy.stop(); }
});

test("--json keeps the raw ISO instants", async () => {
  const j = JSON.parse((await T.run("calendar", "anna", "--json")).stdout);
  assert.equal(j.entries[0].start, "2026-03-01T12:00:00.000Z", "machines get the instant, unformatted");
  assert.equal(j.entries[0].end, "2026-03-01T13:00:00.000Z");
});
