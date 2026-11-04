/**
 * A free/busy grant's `hours` must bound the busy intervals shared with the peer, not only the suggestions.
 *
 * The peer branch of `Platform.freebusy` reads `window_days` and `hours` off the grant, but only `window_days`
 * narrows what is returned: `hours` feeds `hourRules`, which is consulted when `common_free_suggestions` are built.
 * The owner's calendar is shared whole, so a booking at 02:00 or the 08:00–09:30 tail before a 09:00–18:00 window
 * reaches the peer even though the grant says those hours are not shared. The scope is enforced on one half of the
 * same answer and not the other.
 *
 * Red first on 80822fc: (a) the peer's `busy` carries the 02:00–03:00 booking and the whole 08:00–09:30 block;
 * (b) a booking running past 18:00 is shared whole instead of cut at the boundary; (c) an inverted range shares
 * bookings instead of none. Green on 80822fc and kept green: (d) a grant without `hours` shares the calendar as
 * before, (e) the caller's own `busy` is never narrowed by the peer's scope, and the suggestions stay inside the
 * shared hours.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { approveAll, friends, inDays, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(); });
after(async () => { await S.stop(); });

const meeting = () => ({ type: "schedule_meeting", summary: "sync", params: { duration_minutes: 30, window: { start: inDays(2, 0), end: inDays(8, 23) } } });
const day2 = { start: inDays(2, 0), end: inDays(3, 0) };
const intervals = (busy: { start: string; end: string }[]) =>
  busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as [number, number]).sort((x, y) => x[0] - y[0]);
const at = (...hs: number[]) => hs.map((h) => Date.parse(inDays(2, h)));

/** B's owner books an entry; the time is local Asia/Shanghai, like `inDays` itself. */
const book = (B: any, h0: number, h1: number, title: string) =>
  B.owner.req("POST", "/v1/calendar/entries", { start: inDays(2, h0), end: inDays(2, h1), title });

describe("a free/busy grant's hours bound what the peer is told", () => {
  test("(a) bookings outside the shared hours are dropped, and a booking crossing the opening is cut there", async () => {
    const { A, B } = await friends(S.base, { freebusy: true });
    await book(B, 2, 3, "night batch");
    await book(B, 8, 9.5, "early prep");
    await book(B, 10, 11, "standup");
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;

    const fb = await A.bot.freebusy(cid, ["self", B.bot.id], day2);
    const peer = fb.results[B.bot.id];

    assert.deepEqual(intervals(peer.busy), [
      [at(9)[0], at(9.5)[0]],
      [at(10)[0], at(11)[0]],
    ], "only the 09:00–18:00 part of each booking is shared");
    assert.equal(JSON.stringify(fb).includes("night batch"), false, "nothing but intervals leaves the platform");
  });

  test("(b) a booking running past the closing hour is cut at the boundary", async () => {
    const { A, B } = await friends(S.base, { freebusy: true });
    await book(B, 17.5, 19, "late review");
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;

    const fb = await A.bot.freebusy(cid, ["self", B.bot.id], day2);
    assert.deepEqual(intervals(fb.results[B.bot.id].busy), [[at(17.5)[0], at(18)[0]]], "the shared part ends at 18:00");
  });

  test("(c) an inverted hours range shares no busy interval at all", async () => {
    const { A, B, relId } = await friends(S.base);
    await A.bot.requestGrant(relId, "calendar.freebusy.read", { window_days: 14, hours: "19:00-09:00" }, "night shift");
    await approveAll(B.owner);
    await book(B, 10, 11, "standup");
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;

    const fb = await A.bot.freebusy(cid, ["self", B.bot.id], day2);
    assert.deepEqual(fb.results[B.bot.id].busy, [], "a range that cannot mean a window shares nothing");
  });

  test("(d) a grant without hours keeps sharing the calendar whole", async () => {
    const { A, B, relId } = await friends(S.base);
    await A.bot.requestGrant(relId, "calendar.freebusy.read", { window_days: 14 }, "no hour limit");
    await approveAll(B.owner);
    await book(B, 8, 9.5, "early prep");
    await book(B, 17.5, 19, "late review");
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;

    const fb = await A.bot.freebusy(cid, ["self", B.bot.id], day2);
    assert.deepEqual(intervals(fb.results[B.bot.id].busy), [[at(8)[0], at(9.5)[0]], [at(17.5)[0], at(19)[0]]], "no scope.hours means no narrowing");
  });

  test("(e) the caller's own busy stays whole, and the suggestions stay inside the shared hours", async () => {
    const { A, B } = await friends(S.base, { freebusy: true });
    await A.owner.req("POST", "/v1/calendar/entries", { start: inDays(2, 7), end: inDays(2, 8), title: "my own early call" });
    await book(B, 2, 3, "night batch");
    await book(B, 10, 11, "standup");
    const cid = (await A.bot.startConversation(B.bot.id, meeting())).conversation_id as string;

    const fb = await A.bot.freebusy(cid, ["self", B.bot.id], day2);
    assert.deepEqual(intervals(fb.results.self.busy), [[at(7)[0], at(8)[0]]], "the peer's scope never narrows the caller's own view");
    assert.ok(fb.common_free_suggestions.length > 0, "a day with a free afternoon still suggests slots");
    for (const s of fb.common_free_suggestions) {
      const start = Date.parse(s.start);
      assert.ok(start >= at(9)[0] && start + 30 * 60e3 <= at(18)[0], `${s.start} is inside the shared hours`);
      assert.ok(!intervals(fb.results[B.bot.id].busy).some(([b0, b1]) => start < b1 && b0 < start + 30 * 60e3), `${s.start} does not overlap shared busy`);
    }
  });
});
