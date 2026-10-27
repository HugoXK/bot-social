import assert from "node:assert/strict";
import { test } from "node:test";
import { signSsoCookie, verifySsoCookie } from "../src/sso.js";
import { ownerWithBot, startServer } from "./helpers.js";

const secret = "test-sso-secret-not-for-production";
const saved = { secret: process.env.BOTSOCIAL_SSO_SECRET, owner: process.env.BOTSOCIAL_SSO_OWNER_ID, portal: process.env.BOTSOCIAL_SSO_PORTAL, file: process.env.BOTSOCIAL_SSO_SECRET_FILE };

test("SSO cookie signature and expiry", () => {
  const now = Date.now();
  const value = signSsoCookie(secret, { sub: "gh-1", email: "alice@example.com", name: "Alice" }, now);
  assert.equal(verifySsoCookie(secret, value, now)?.email, "alice@example.com");
  assert.equal(verifySsoCookie("wrong", value, now), null);
  assert.equal(verifySsoCookie(secret, value, now + 8 * 86400e3), null);
  assert.equal(verifySsoCookie(secret, undefined, now), null);
});

test("the SSO endpoint exchanges a valid cookie for a normal owner login token", async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const A = await ownerWithBot(s.base, "sso-user");
  process.env.BOTSOCIAL_SSO_SECRET = secret;
  process.env.BOTSOCIAL_SSO_OWNER_ID = A.owner_id;
  process.env.BOTSOCIAL_SSO_PORTAL = "https://portal.example";
  delete process.env.BOTSOCIAL_SSO_SECRET_FILE;
  try {
    const start = await fetch(`${s.base}/v1/auth/sso/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.match(start.headers.get("location") || "", /^https:\/\/portal\.example\/\?return=/);

    const cookie = signSsoCookie(secret, { sub: "gh-1", email: "alice@example.com" });
    const r = await fetch(`${s.base}/v1/auth/sso`, { method: "POST", headers: { cookie: `hugoxk_sso=${cookie}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.owner_id, A.owner_id);
    const me = await fetch(`${s.base}/v1/me`, { headers: { authorization: `Bearer ${body.owner_token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).owner_id, A.owner_id);

    const bad = await fetch(`${s.base}/v1/auth/sso`, { method: "POST", headers: { cookie: "hugoxk_sso=nope" } });
    assert.equal(bad.status, 401);
  } finally {
    for (const [k, v] of [["BOTSOCIAL_SSO_SECRET", saved.secret], ["BOTSOCIAL_SSO_OWNER_ID", saved.owner], ["BOTSOCIAL_SSO_PORTAL", saved.portal], ["BOTSOCIAL_SSO_SECRET_FILE", saved.file]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
