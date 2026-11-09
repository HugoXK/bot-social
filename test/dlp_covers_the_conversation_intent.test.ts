import assert from "node:assert/strict";
import { test } from "node:test";
import { expectApiError, friends, startServer } from "./helpers.js";

// `conversation.create` carries an `intent` the peer reads the moment the chat opens: `conversation.started`
// delivers it as `untrusted_content.intent`, and every later delivery repeats `{type, summary}`. So the intent's
// free text is outbound text like a message's, and the same outbound DLP must see it before the peer does. Today
// it does not: a value the draft door blocks with `422 dlp_blocked` opens a conversation here and lands in the
// peer's queue verbatim.
//
// A refused create writes nothing at all -- no conversation row, no `conversation.started` event, no push -- so a
// caller cannot use the refusal as a way to leave the peer an empty thread either.

const API_KEY = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2";

/** Two friends that may chat either way, both directions granted (the `friends` helper writes them). */
async function pair(t: any) {
  const s = await startServer();
  t.after(s.stop);
  const { A, B } = await friends(s.base);
  const conversations = () => (s.platform.db.prepare("SELECT COUNT(*) n FROM conversations").get() as any).n as number;
  const startedEvents = async () => ((await B.bot.events() as any).events ?? []).filter((e: any) => e.event_type === "conversation.started");
  return { s, A, B, conversations, startedEvents };
}

test("a: a blocked secret in the intent summary is refused before the peer reads it", async (t) => {
  const h = await pair(t);
  const err = await expectApiError(
    h.A.bot.startConversation(h.B.bot.id, { type: "general_chat", summary: `deploy with ${API_KEY}` }),
    422, "dlp_blocked",
  );
  assert.ok((err as any).body?.error?.categories?.includes("secret.api_key"), "the refusal names the rule that hit, never the value");
  assert.equal(h.conversations(), 0, "a refused create leaves no conversation to read");
  assert.equal((await h.startedEvents()).length, 0, "and the peer is not told a chat started");
});

test("b: the same secret in the intent's success_criteria is refused too", async (t) => {
  const h = await pair(t);
  await expectApiError(
    h.A.bot.startConversation(h.B.bot.id, { type: "general_chat", summary: "ship it", success_criteria: `rotate ${API_KEY}` }),
    422, "dlp_blocked",
  );
  assert.equal(h.conversations(), 0, "nothing is written");
  assert.equal((await h.startedEvents()).length, 0, "the peer hears nothing");
});

test("c: and in a free-text field inside intent.params", async (t) => {
  const h = await pair(t);
  await expectApiError(
    h.A.bot.startConversation(h.B.bot.id, { type: "general_chat", summary: "ship it", params: { note: `deploy with ${API_KEY}` } }),
    422, "dlp_blocked",
  );
  assert.equal(h.conversations(), 0, "nothing is written");
  assert.equal((await h.startedEvents()).length, 0, "the peer hears nothing");
});

test("d: a clean intent still opens the chat, and the peer reads the summary", async (t) => {
  const h = await pair(t);
  const conv = await h.A.bot.startConversation(h.B.bot.id, { type: "general_chat", summary: "plan the launch" }) as any;
  assert.ok(conv.conversation_id, "the chat opens");
  const events = await h.startedEvents();
  assert.equal(events.length, 1, "the peer is told once");
  assert.equal(events[0].untrusted_content.intent.summary, "plan the launch", "and reads the summary it was given");
});

test("e: the same value through the message draft door is still refused (the rule exists)", async (t) => {
  const h = await pair(t);
  const conv = await h.A.bot.startConversation(h.B.bot.id, { type: "general_chat", summary: "clean" }) as any;
  await expectApiError(h.A.bot.draftMessage(conv.conversation_id, { text: `deploy with ${API_KEY}` }), 422, "dlp_blocked");
});
