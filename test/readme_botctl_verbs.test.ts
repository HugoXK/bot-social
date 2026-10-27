import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// A README example naming a verb botctl does not dispatch is a broken instruction: the reader copies it and
// gets "✗ unknown command". README.md:578-579 did exactly that (`friend-request`, `friend-requests`), and the
// real owner-side verb is `requests` (scripts/botctl.ts). These cases tie the example block to the dispatch
// table so a verb can only appear in the docs if the CLI answers to it.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const cli = readFileSync(new URL("../scripts/botctl.ts", import.meta.url), "utf8");

// The example block under "Advanced: botctl CLI", anchored on its alias line so the test never wanders into
// another fenced block.
function exampleBlock(): string {
  const alias = readme.indexOf("alias botctl=");
  assert.ok(alias > 0, "the botctl example block still opens with its alias line");
  const open = readme.lastIndexOf("```", alias);
  const close = readme.indexOf("\n```", alias);
  assert.ok(open >= 0 && close > alias, "the botctl example block is fenced");
  return readme.slice(open, close);
}

// Every `case "verb":` label is a dispatch arm; aliases share one arm (case "start": case "start-conversation").
const dispatched = new Set([...cli.matchAll(/case\s+"([a-z0-9-]+)"\s*:/g)].map((m) => m[1]));

test("every botctl verb in the README example block is dispatched by scripts/botctl.ts", () => {
  const block = exampleBlock();
  const used = [...new Set([...block.matchAll(/\bbotctl ([a-z][a-z0-9-]*)/g)].map((m) => m[1]))];
  // Guard against a vacuous pass: an empty or half-parsed block would "find" nothing to check.
  assert.ok(used.length >= 10, `the example block still exercises the CLI (saw ${used.length} verbs)`);
  assert.ok(dispatched.size >= 20, `the dispatch table parsed (saw ${dispatched.size} verbs)`);
  const unknown = used.filter((verb) => !dispatched.has(verb));
  assert.deepEqual(unknown, [], `README example verbs that botctl does not dispatch: ${unknown.join(", ")}`);
  // The refusal this test stands in for: an unknown verb is the CLI's default arm, not a silent pass.
  assert.match(cli, /default: fail\(`unknown command/, "botctl still refuses an unknown verb");
});

test("the friend flow in the README names the verbs that exist: invite, join, requests", () => {
  const block = exampleBlock();
  // One side mints a link, the other joins it; the owner-side pending list is `requests <name>`.
  assert.match(block, /\bbotctl invite /, "the block shows the inviting side");
  assert.match(block, /\bbotctl join /, "the block shows the joining side");
  assert.match(block, /\bbotctl requests /, "the owner-side pending list is `requests`");
  // No invented alias may come back: `friend-request` / `friend-requests` never dispatched.
  assert.equal(readme.includes("friend-request"), false, "the README invents no friend-request verb");
});
