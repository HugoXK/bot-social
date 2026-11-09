import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEd25519 } from "../src/crypto.js";
import { friends, startServer } from "./helpers.js";

// A key the platform holds is signed with on every custodial request, so the rotation deadline an owner set on it
// (`addKey` gives the old keys a seven-day window) must not survive the adoption: the day it passes, `verifyEnvelope`
// answers 401 "unknown, revoked or expired kid" for the platform's own signatures, and the owner has no door left to
// fix an identity whose private key the platform now keeps. Adoption is the moment to clear the deadline -- the
// uploaded key becomes the platform's, and it stays valid until it is revoked or custody is disabled.
//
// The window itself is untouched: a key whose deadline has already passed is still refused as `key_not_registered`,
// exactly as before. Adoption only clears the deadline it lets through, so an expired credential never comes back.

const owner = (o: any) => ({ kind: "owner" as const, ownerId: o.owner_id });
const rowOf = (s: any, botId: string, kid: string) =>
  s.platform.db.prepare("SELECT kid, status, expires_at FROM bot_keys WHERE bot_id = ? AND kid = ?").get(botId, kid) as any;

/** One owner and one friend's bot, with the owner's own key `k1` in place (the `friends` helper writes both). */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  return { s, A, B };
}

test("a: the rotation deadline a key still inside its window is cleared by the adoption, so the platform's identity keeps working", async (t) => {
  const { s, A, B } = await pair(t);
  // The owner rotated once: `k1` is still active, with the seven-day verification window `addKey` left on it.
  await A.owner.req("POST", `/v1/bots/${A.bot.id}/keys`, { kid: "k2", value: generateEd25519().publicKey, retire_others_in_days: 7 });
  assert.ok(rowOf(s, A.bot.id, "k1").expires_at, "the rotation dated the old key");

  const adopted: any = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  assert.equal(adopted.kid, "k1");
  assert.equal(adopted.mode, "uploaded");
  assert.equal(rowOf(s, A.bot.id, "k1").expires_at, null, "the key the platform keeps no longer carries a deadline");
  assert.equal(rowOf(s, A.bot.id, "k2").expires_at, null, "the newly added key is untouched, and it never had one");

  // The proof is the door itself: an envelope the platform signs with the adopted key is accepted.
  const cb = s.platform.custodialBot(owner(A), A.bot.id);
  const conv: any = s.platform.createConversation(cb.bp, cb.sign("conversation.create", {
    type: "direct", peer_bot_id: B.bot.id, intent: { type: "general_chat", summary: "plan the launch" },
  }, { to: B.bot.id }));
  assert.ok(conv.conversation_id, "the platform's own signature is not refused as an expired kid");
});

test("b: a window that has already closed is still refused, and adoption leaves that row alone", async (t) => {
  const { s, A } = await pair(t);
  // Move `k1`'s window into the past: this is the state a seven-day rotation reaches on its own.
  const closed = new Date(Date.now() - 60_000).toISOString();
  s.platform.db.prepare("UPDATE bot_keys SET expires_at = ? WHERE bot_id = ? AND kid = 'k1'").run(closed, A.bot.id);

  assert.throws(
    () => s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem }),
    (e: any) => e.status === 400 && e.code === "key_not_registered",
    "an expired credential is not brought back to life",
  );
  assert.equal(rowOf(s, A.bot.id, "k1").expires_at, closed, "the refused adoption wrote nothing");
  assert.equal(s.platform.custodyStatus(owner(A), A.bot.id)[0].custodial, false, "the bot is still not custodial");
});

test("c: a key that was revoked is still not adoptable, and an undated adoption is unchanged", async (t) => {
  const { s, A } = await pair(t);
  const adopted: any = s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem });
  assert.equal(adopted.custodial, true);
  assert.equal(adopted.kid, "k1", "an undated key is adopted exactly as before");
  assert.equal(rowOf(s, A.bot.id, "k1").expires_at, null);
  assert.equal(s.platform.custodyStatus(owner(A), A.bot.id)[0].custodial, true);

  // Revocation is the boundary adoption cannot cross: the platform must never resurrect a key the owner retired.
  s.platform.disableCustody(owner(A), A.bot.id);
  s.platform.db.prepare("UPDATE bot_keys SET status = 'revoked' WHERE bot_id = ? AND kid = 'k1'").run(A.bot.id);
  assert.throws(
    () => s.platform.enableCustody(owner(A), A.bot.id, { private_key_pem: A.kp.privateKeyPem }),
    (e: any) => e.status === 400 && e.code === "key_not_registered",
    "a revoked key is still refused",
  );
});
