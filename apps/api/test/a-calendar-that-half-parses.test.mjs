/**
 * The calendar feed, and the half-parse that would be worse than no parse.
 *
 * ============================================================
 * THE FAILURE THIS FILE IS ABOUT
 * ============================================================
 *
 * A calendar decides whether the agent promises a customer a person. Get it
 * wrong in the generous direction and somebody in court all Tuesday is offered
 * to a customer as available; get it wrong in the mean direction and a business
 * that has staff answers as though it does not.
 *
 * The dangerous one is neither. It is the event that does not parse: a folded
 * DTSTART, a monthly recurrence, a TZID nobody recognises. Those vanish, and
 * what is left looks like a complete answer. The person appears free at exactly
 * the times nothing could see.
 *
 * So the rule is that anything not understood is COUNTED and reported, and
 * these tests are mostly about the counting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCalendar, busyAt, CALENDAR_WINDOW_DAYS } from "@nexus/employees";

const WINDOW_FROM = new Date("2026-09-01T00:00:00Z");
const WINDOW_TO = new Date("2026-09-15T00:00:00Z");

const wrap = (...events) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");

const event = (lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

const parse = (ics, zone = "UTC") => parseCalendar(ics, WINDOW_FROM, WINDOW_TO, zone);

// ============================================================
// The shapes a real feed actually contains
// ============================================================

test("a plain event becomes one busy block", () => {
  const { busy, unsupported } = parse(
    wrap(event(["UID:a@x", "DTSTART:20260902T090000Z", "DTEND:20260902T103000Z"]))
  );
  assert.equal(unsupported, 0);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].startsAt.toISOString(), "2026-09-02T09:00:00.000Z");
  assert.equal(busy[0].endsAt.toISOString(), "2026-09-02T10:30:00.000Z");
});

test("a folded line is unfolded before it is read", () => {
  // RFC 5545 splits lines past 75 octets and continues them with a leading
  // space. Parse without unfolding and a folded DTSTART becomes an event with
  // no start, which is dropped -- silently, which is the whole problem.
  const folded = ["BEGIN:VEVENT", "UID:folded@x", "DTSTART:2026090", " 2T140000Z", "DTEND:20260902T150000Z", "END:VEVENT"].join("\r\n");
  const { busy } = parse(wrap(folded));
  assert.equal(busy.length, 1, "a folded DTSTART was dropped");
  assert.equal(busy[0].startsAt.toISOString(), "2026-09-02T14:00:00.000Z");
});

test("DURATION stands in for a missing DTEND", () => {
  const { busy } = parse(
    wrap(event(["UID:d@x", "DTSTART:20260903T090000Z", "DURATION:PT90M"]))
  );
  assert.equal(busy.length, 1);
  assert.equal(busy[0].endsAt.toISOString(), "2026-09-03T10:30:00.000Z");
});

test("an all-day event blocks the whole day", () => {
  const { busy } = parse(
    wrap(event(["UID:allday@x", "DTSTART;VALUE=DATE:20260904"]))
  );
  assert.equal(busy.length, 1);
  assert.equal(busy[0].startsAt.toISOString(), "2026-09-04T00:00:00.000Z");
  assert.equal(busy[0].endsAt.toISOString(), "2026-09-05T00:00:00.000Z");
});

test("a floating time means where the person is, not where the server is", () => {
  // "09:00" with no zone is 09:00 wherever the calendar's owner sits. Reading
  // it as UTC would make a Dubai employee busy at one in the afternoon.
  const { busy } = parse(
    wrap(event(["UID:f@x", "DTSTART:20260902T090000", "DTEND:20260902T100000"])),
    "Asia/Dubai"
  );
  assert.equal(busy.length, 1);
  assert.equal(busy[0].startsAt.toISOString(), "2026-09-02T05:00:00.000Z", "Dubai is UTC+4");
});

test("a named zone is resolved, including across a clock change", () => {
  // London is UTC+1 in September and UTC+0 in December. A fixed offset table
  // would get exactly one of these right.
  const september = parseCalendar(
    wrap(event(["UID:tz@x", "DTSTART;TZID=Europe/London:20260902T090000", "DTEND;TZID=Europe/London:20260902T100000"])),
    WINDOW_FROM,
    WINDOW_TO
  );
  assert.equal(september.busy[0].startsAt.toISOString(), "2026-09-02T08:00:00.000Z");

  const december = parseCalendar(
    wrap(event(["UID:tz2@x", "DTSTART;TZID=Europe/London:20261202T090000", "DTEND;TZID=Europe/London:20261202T100000"])),
    new Date("2026-12-01T00:00:00Z"),
    new Date("2026-12-15T00:00:00Z")
  );
  assert.equal(december.busy[0].startsAt.toISOString(), "2026-12-02T09:00:00.000Z");
});

// ============================================================
// What must NOT make somebody busy
// ============================================================

test("a cancelled event does not block anything", () => {
  const { busy } = parse(
    wrap(event(["UID:c@x", "DTSTART:20260902T090000Z", "DTEND:20260902T100000Z", "STATUS:CANCELLED"]))
  );
  assert.equal(busy.length, 0);
});

test("an event marked free is taken at its word", () => {
  // TRANSP:TRANSPARENT is the calendar's own way of saying "this does not make
  // me unavailable" -- a birthday, a reminder, a tentative hold.
  const { busy } = parse(
    wrap(event(["UID:t@x", "DTSTART:20260902T090000Z", "DTEND:20260902T100000Z", "TRANSP:TRANSPARENT"]))
  );
  assert.equal(busy.length, 0);
});

test("an event outside the window is not carried", () => {
  const { busy } = parse(
    wrap(event(["UID:old@x", "DTSTART:20260101T090000Z", "DTEND:20260101T100000Z"]))
  );
  assert.equal(busy.length, 0);
});

test("a zero-length event is a marker, not a commitment", () => {
  const { busy } = parse(
    wrap(event(["UID:z@x", "DTSTART:20260902T090000Z", "DTEND:20260902T090000Z"]))
  );
  assert.equal(busy.length, 0);
});

// ============================================================
// Recurrence — what "every Tuesday I am in court" needs
// ============================================================

test("a weekly rule repeats on the day it names", () => {
  const { busy, unsupported } = parse(
    wrap(
      event([
        "UID:court@x",
        "DTSTART:20260901T090000Z",
        "DTEND:20260901T120000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
      ])
    )
  );
  assert.equal(unsupported, 0);
  // 1 and 8 September 2026 are Tuesdays; the window ends on the 15th.
  assert.equal(busy.length, 2, `expected two Tuesdays, got ${busy.length}`);
  for (const block of busy) {
    assert.equal(block.startsAt.getUTCDay(), 2, "an occurrence landed off Tuesday");
  }
});

test("a daily rule stops at UNTIL", () => {
  const { busy } = parse(
    wrap(
      event([
        "UID:daily@x",
        "DTSTART:20260902T090000Z",
        "DTEND:20260902T093000Z",
        "RRULE:FREQ=DAILY;UNTIL=20260904T235959Z",
      ])
    )
  );
  assert.equal(busy.length, 3, "UNTIL was ignored or applied off by one");
});

test("a daily rule stops after COUNT occurrences", () => {
  const { busy } = parse(
    wrap(
      event([
        "UID:count@x",
        "DTSTART:20260902T090000Z",
        "DTEND:20260902T093000Z",
        "RRULE:FREQ=DAILY;COUNT=2",
      ])
    )
  );
  assert.equal(busy.length, 2);
});

test("INTERVAL is honoured", () => {
  const { busy } = parse(
    wrap(
      event([
        "UID:alt@x",
        "DTSTART:20260902T090000Z",
        "DTEND:20260902T093000Z",
        "RRULE:FREQ=DAILY;INTERVAL=3",
      ])
    )
  );
  // 2, 5, 8, 11, 14 September.
  assert.equal(busy.length, 5, `every third day should give five, got ${busy.length}`);
});

test("a moved occurrence does not still block its old slot", () => {
  // Without EXDATE, "every Tuesday except the one I moved" reports somebody
  // busy at a time their own calendar shows free -- and they are the one who
  // will be blamed for not answering.
  const { busy } = parse(
    wrap(
      event([
        "UID:ex@x",
        "DTSTART:20260901T090000Z",
        "DTEND:20260901T120000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
        "EXDATE:20260908T090000Z",
      ])
    )
  );
  assert.equal(busy.length, 1, "the excluded occurrence is still blocking");
  assert.equal(busy[0].startsAt.toISOString(), "2026-09-01T09:00:00.000Z");
});

test("a recurrence this cannot expand is counted, never dropped", () => {
  // THE POINT OF THE WHOLE FILE. Monthly and yearly are not expanded. Dropping
  // them silently would leave the person looking free on the one day a month
  // they are not -- and nothing anywhere would say so.
  const { busy, unsupported } = parse(
    wrap(
      event([
        "UID:monthly@x",
        "DTSTART:20260902T090000Z",
        "DTEND:20260902T100000Z",
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=2",
      ])
    )
  );
  assert.equal(busy.length, 0, "an unsupported rule must not be expanded as if it were understood");
  assert.equal(unsupported, 1, "an unsupported rule must be REPORTED, which is the whole design");
});

test("understood and not-understood events coexist without hiding each other", () => {
  const { busy, unsupported } = parse(
    wrap(
      event(["UID:ok@x", "DTSTART:20260902T090000Z", "DTEND:20260902T100000Z"]),
      event(["UID:no@x", "DTSTART:20260903T090000Z", "DTEND:20260903T100000Z", "RRULE:FREQ=YEARLY"])
    )
  );
  assert.equal(busy.length, 1);
  assert.equal(unsupported, 1);
});

// ============================================================
// Robustness — a feed is somebody else's output
// ============================================================

test("rubbish in does not throw", () => {
  // The feed comes from a service this platform does not control. A parser that
  // throws takes the sync down for everybody on that calendar.
  for (const junk of ["", "not a calendar", "BEGIN:VCALENDAR", "BEGIN:VEVENT\r\nEND:VEVENT"]) {
    const out = parse(junk);
    assert.deepEqual(out.busy, [], `"${junk.slice(0, 20)}" produced busy time`);
  }
});

test("an event with no start is dropped rather than guessed at", () => {
  const { busy } = parse(wrap(event(["UID:nostart@x", "DTEND:20260902T100000Z"])));
  assert.equal(busy.length, 0);
});

test("a repeating event does not run away when nothing bounds it", () => {
  // FREQ=DAILY with no COUNT and no UNTIL is legal and means forever. The
  // expansion is bounded by the window rather than by the rule, so this is a
  // fixed number of blocks rather than a loop somebody has to remember to
  // break out of.
  const { busy } = parse(
    wrap(event(["UID:forever@x", "DTSTART:20260902T090000Z", "DTEND:20260902T093000Z", "RRULE:FREQ=DAILY"]))
  );
  assert.ok(busy.length > 5 && busy.length < 20, `expected roughly a fortnight, got ${busy.length}`);
});

test("busyAt answers the only question the reply path asks", () => {
  const { busy } = parse(
    wrap(event(["UID:now@x", "DTSTART:20260902T090000Z", "DTEND:20260902T100000Z"]))
  );
  assert.equal(busyAt(busy, new Date("2026-09-02T09:30:00Z")), true);
  assert.equal(busyAt(busy, new Date("2026-09-02T10:00:00Z")), false, "the end is exclusive");
  assert.equal(busyAt(busy, new Date("2026-09-02T08:59:00Z")), false);
});

test("the window is a fortnight, which is what a sync has to cover", () => {
  assert.equal(CALENDAR_WINDOW_DAYS, 14);
});
