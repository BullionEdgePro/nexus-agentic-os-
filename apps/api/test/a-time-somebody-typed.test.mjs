/**
 * The clock an operator types, and whose clock it turns out to be.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Adding an appointment by hand shipped on 2026-08-26, having been deliberately
 * absent before it. Every field on that form either saves or is refused with a
 * sentence — except the time, which is the one input that can be wrong without
 * looking wrong. A wall clock sent as though it were the reader's own produces
 * a real booking at the wrong hour: saved successfully, displayed plausibly,
 * kept in the diary, and discovered when a customer arrives four hours early.
 *
 * The read side of the diary already argues this in its own comment — an
 * appointment is a moment somebody physically walks into an office in Dubai,
 * not a number on an operator's screen in London. This is the same argument
 * running backwards, and the reason the conversion lives in `lib/zoned-time.ts`
 * rather than inside a component is so it could be checked here at all.
 *
 * THESE ARE REAL ASSERTIONS ABOUT REAL INSTANTS, not source-level greps. The
 * whole class of defect is arithmetic being confidently wrong, and a test that
 * only proved the right function was called would be exactly as wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { wallClockToInstant, zoneOffsetMs, describeInstant } from "../../web/lib/zoned-time.ts";

test("a time typed for Dubai is stored as the Dubai instant", () => {
  // 15:00 in Asia/Dubai is 11:00 UTC. This is the whole feature: an operator
  // anywhere in the world typing 15:00 means the customer's three o'clock.
  assert.equal(
    wallClockToInstant("2026-08-28", "15:00", "Asia/Dubai"),
    "2026-08-28T11:00:00.000Z"
  );
});

test("the reader's own clock never enters it", () => {
  // The same typed values, read into three zones, must give three different
  // instants -- if any two agreed, something is ignoring the zone argument and
  // falling back to a single clock, which is the defect itself.
  const dubai = wallClockToInstant("2026-08-28", "09:30", "Asia/Dubai");
  const london = wallClockToInstant("2026-08-28", "09:30", "Europe/London");
  const utc = wallClockToInstant("2026-08-28", "09:30", "UTC");
  assert.notEqual(dubai, london);
  assert.notEqual(london, utc);
  assert.equal(utc, "2026-08-28T09:30:00.000Z");
  // Dubai is UTC+4 year round, London UTC+1 in August.
  assert.equal(dubai, "2026-08-28T05:30:00.000Z");
  assert.equal(london, "2026-08-28T08:30:00.000Z");
});

test("a zone with daylight saving is read at the right side of the change", () => {
  // Europe/London 2026: BST from 29 March to 25 October. An appointment either
  // side of the change must take the offset in force ON THE DAY, not whichever
  // one happens to apply when the form is open.
  //
  // MEASURED, NOT ASSUMED: these four cases give the same answer with one
  // correction pass as with two. This comment first claimed they were the
  // reason the conversion corrects twice; they are not, and the case that
  // actually is has its own test below.
  assert.equal(
    wallClockToInstant("2026-03-28", "12:00", "Europe/London"),
    "2026-03-28T12:00:00.000Z",
    "the day before the clocks go forward is GMT"
  );
  assert.equal(
    wallClockToInstant("2026-03-30", "12:00", "Europe/London"),
    "2026-03-30T11:00:00.000Z",
    "the day after is BST — an hour ahead of UTC"
  );
  // And the same across the autumn change, in the other direction.
  assert.equal(
    wallClockToInstant("2026-10-24", "12:00", "Europe/London"),
    "2026-10-24T11:00:00.000Z"
  );
  assert.equal(
    wallClockToInstant("2026-10-26", "12:00", "Europe/London"),
    "2026-10-26T12:00:00.000Z"
  );
});

test("a zone west of UTC is not simply mirrored", () => {
  // A sign error is the classic version of this bug and passes every test
  // written only against zones ahead of UTC -- all five businesses are in one.
  assert.equal(
    wallClockToInstant("2026-08-28", "09:00", "America/New_York"),
    "2026-08-28T13:00:00.000Z"
  );
});

test("a half-hour zone survives the arithmetic", () => {
  // Offsets are not whole hours everywhere, and a conversion that quietly
  // rounded to the hour would be right in Dubai and thirty minutes out here.
  assert.equal(
    wallClockToInstant("2026-08-28", "10:00", "Asia/Kolkata"),
    "2026-08-28T04:30:00.000Z"
  );
});

test("nothing typed produces nothing, not a guess", () => {
  // The caller can say "pick a date and a time". It cannot un-book an
  // appointment, so an empty or unreadable field must never become an instant.
  assert.equal(wallClockToInstant("", "15:00", "Asia/Dubai"), "");
  assert.equal(wallClockToInstant("2026-08-28", "", "Asia/Dubai"), "");
  assert.equal(wallClockToInstant("not-a-date", "15:00", "Asia/Dubai"), "");
  assert.equal(wallClockToInstant("2026-08-28", "half past four", "Asia/Dubai"), "");
});

test("an unusable timezone falls back to UTC rather than shifting the time", () => {
  // organizations.timezone is free text. Whatever this does must be something
  // the form has already told the reader, and the form prints the zone it used.
  assert.equal(zoneOffsetMs(Date.now(), "Not/AZone"), 0);
  assert.equal(
    wallClockToInstant("2026-08-28", "15:00", "Not/AZone"),
    "2026-08-28T15:00:00.000Z"
  );
});

test("the confirmation reads back in the same zone it was typed in", () => {
  // The preview under the fields is the operator's only chance to notice a
  // wrong answer before a customer is told one. Round-tripping is the point:
  // type 15:00 for Dubai, read 15:00 back.
  const instant = wallClockToInstant("2026-08-28", "15:00", "Asia/Dubai");
  assert.match(describeInstant(instant, "Asia/Dubai"), /15:00/);
  // And it is genuinely the zone doing the work, not the string coming back.
  assert.match(describeInstant(instant, "UTC"), /11:00/);
});

test("an appointment does not silently jump a day", () => {
  // Late-evening times in a zone ahead of UTC belong to the NEXT UTC day, and
  // early-morning times in a zone behind it to the previous one. Both are
  // correct and both look like a bug to somebody skim-reading a date, so they
  // are pinned rather than left to be "fixed" later.
  assert.equal(
    wallClockToInstant("2026-08-28", "01:00", "Asia/Dubai"),
    "2026-08-27T21:00:00.000Z"
  );
  assert.equal(
    wallClockToInstant("2026-08-28", "22:00", "America/New_York"),
    "2026-08-29T02:00:00.000Z"
  );
});

test("a clock time that never happened resolves forwards, and is pinned because it is arbitrary", () => {
  // THE ONE CASE THE SECOND CORRECTION PASS CHANGES, found by running both
  // versions over ten boundary dates rather than by reasoning about it -- the
  // four ordinary DST cases above agree either way.
  //
  // On 29 March 2026 London goes 01:00 -> 02:00, so 01:30 does not exist. There
  // is no right answer: one pass sends it back to 00:30 local, two send it
  // forward to 02:30. Neither is the time that was typed, because that time was
  // never on any clock.
  //
  // Pinned rather than corrected, and deliberately: all five businesses are in
  // Asia/Dubai, which has no daylight saving, so nobody here can reach this.
  // The value of writing it down is that the next person to see 02:30 come out
  // of a form that said 01:30 finds a test saying it was known, instead of
  // reading it as the arithmetic being broken.
  //
  // If a business in a DST zone is ever onboarded, the form should REFUSE a
  // skipped hour rather than pick a side. That is the real fix and it is not
  // worth building for nobody.
  assert.equal(
    wallClockToInstant("2026-03-29", "01:30", "Europe/London"),
    "2026-03-29T01:30:00.000Z",
    "the skipped hour resolves forward, to 02:30 London"
  );
  assert.equal(
    wallClockToInstant("2026-03-08", "02:30", "America/New_York"),
    "2026-03-08T06:30:00.000Z"
  );

  // The AMBIGUOUS hour -- the one that happens twice in autumn -- is not
  // arbitrary in the same way: both readings are real instants an hour apart.
  // This takes the LATER one, after the clocks go back.
  //
  // I asserted the earlier one here first, from reasoning, and it was wrong.
  // Which is the argument for the whole file: this arithmetic is not something
  // to be confident about without running it, and every number above was
  // checked rather than derived.
  assert.equal(
    wallClockToInstant("2026-10-25", "01:30", "Europe/London"),
    "2026-10-25T01:30:00.000Z",
    "01:30 GMT, the second time the clock reads 01:30 that morning"
  );
});
