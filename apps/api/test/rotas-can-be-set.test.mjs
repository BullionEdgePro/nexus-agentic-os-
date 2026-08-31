// An employee with no rota is not available, and until now nothing could give
// them one.
//
// `working_hours` had NO WRITER anywhere in packages/db or apps/api — only
// reads. `createEmployee` does not accept a rota, so every employee ever created
// through the product arrived with `{}`. Both readers treat that as NOT
// available, deliberately: `hasStaffOnShift` will not promise a person nobody
// has said is working, and `isScheduledThroughout` will not offer them an
// appointment.
//
// So the employee layer shipped, worked, and was permanently off-shift. Nothing
// errored. It surfaced only when bookings went live and the diary could offer
// nothing at all — at which point the four booking businesses turned out to have
// zero employees anyway, which is the same failure one level up.
//
// The other half of this file is the validator. `working_hours` is jsonb, so
// Postgres accepts any shape at all: {"Monday": [...]} and {"mon":[{"from":"9am"}]}
// both store cleanly and read back as a rota matching no window, ever. That is
// the failure shape this platform keeps producing — not an error, a plausible
// empty result — so it has to be caught on the way IN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseWeeklySchedule, weeklyHours, isScheduledAt } from "@nexus/employees";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "employees.ts");
const DB = read("packages", "db", "src", "employees.ts");
const EDITOR = read("apps", "web", "app", "deck", "team", "rota-editor.tsx");

// ============================================================
// The validator: what gets rejected, and why each one matters
// ============================================================

test("a normal week is accepted and normalized", () => {
  const result = parseWeeklySchedule({ mon: [{ start: "9:00", end: "17:30" }] });
  assert.equal(result.ok, true);
  // Zero-padded on the way in, so two operators typing the same week produce
  // byte-identical rows — `working_hours <> '{}'` is how the rest of the system
  // asks whether anybody has set this at all.
  assert.deepEqual(result.schedule, { mon: [{ start: "09:00", end: "17:30" }] });
});

test("a capitalised or long weekday is refused, not silently dropped", () => {
  // "Monday" and "MON" are the first two things a person types. Ignoring an
  // unknown key is how a rota ends up half-stored and the employee ends up
  // unavailable on the days nobody noticed were missing.
  const long = parseWeeklySchedule({ Monday: [{ start: "09:00", end: "17:00" }] });
  assert.equal(long.ok, false);
  assert.match(long.errors[0], /not a weekday/);

  // Case alone is forgiven — it is unambiguous.
  const upper = parseWeeklySchedule({ MON: [{ start: "09:00", end: "17:00" }] });
  assert.equal(upper.ok, true);
  assert.deepEqual(upper.schedule, { mon: [{ start: "09:00", end: "17:00" }] });
});

test("a malformed time is refused with the day and the value named", () => {
  // The single most likely typo, and the one with no symptom: "9am" stores fine
  // as jsonb and matches no window for the rest of that employee's life.
  const result = parseWeeklySchedule({ tue: [{ start: "9am", end: "5pm" }] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /tue/);
  assert.match(result.errors[0], /9am/);
});

test("an out-of-range time is refused", () => {
  assert.equal(parseWeeklySchedule({ wed: [{ start: "25:00", end: "26:00" }] }).ok, false);
  assert.equal(parseWeeklySchedule({ wed: [{ start: "09:60", end: "17:00" }] }).ok, false);
});

test("a zero-length window is refused rather than stored", () => {
  // presence.ts returns false for start === end, so a saved zero-length shift is
  // a shift that never applies — indistinguishable from not being there.
  const result = parseWeeklySchedule({ thu: [{ start: "09:00", end: "09:00" }] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /zero minutes/);
});

test("overlapping windows in one day are reported", () => {
  const result = parseWeeklySchedule({
    fri: [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "17:00" }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /overlaps/);
});

test("every problem is reported at once, not just the first", () => {
  // An editor that surfaces one bad window per save turns a five-day rota into
  // five round trips.
  const result = parseWeeklySchedule({
    mon: [{ start: "9am", end: "17:00" }],
    tue: [{ start: "09:00", end: "09:00" }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2, `expected several errors, got ${result.errors.length}`);
});

test("the shifts the editor seeds are ones the server will accept", () => {
  // A BUG FOUND BY CLICKING THE BUTTON, not by reading the code. The editor
  // originally seeded a fixed 09:00–18:00 for the first shift and a fixed
  // 14:00–17:00 for the second, so pressing "+ shift" twice built a rota that
  // overlaps — which this validator correctly refuses. A default that cannot be
  // saved is worse than a blank one: the error surfaces at save time and reads
  // as the editor being broken.
  //
  // The seeds now step forward from the previous window's end. These are the
  // exact values the editor produces for one, two and three shifts, verified in
  // the browser; if the seeding logic drifts back into overlapping, this fails.
  const seeded = parseWeeklySchedule({
    mon: [
      { start: "09:00", end: "17:00" },
      { start: "18:00", end: "20:00" },
      { start: "21:00", end: "23:00" },
    ],
  });
  assert.equal(seeded.ok, true, seeded.errors.join(" "));
  assert.equal(weeklyHours(seeded.schedule), 12);

  // And the shape that used to be seeded is still refused, so this test is
  // pinning a real property rather than describing whatever the code does.
  const overlapping = parseWeeklySchedule({
    mon: [{ start: "09:00", end: "18:00" }, { start: "14:00", end: "17:00" }],
  });
  assert.equal(overlapping.ok, false);
});

test("an empty rota is valid — it means 'not working', not 'invalid'", () => {
  // Refusing it would make "I have no hours set yet" impossible to express, and
  // the honest representation of that state is what keeps it visible.
  const result = parseWeeklySchedule({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.schedule, {});
  assert.equal(weeklyHours({}), 0);
});

test("a rota is not an array or a string", () => {
  assert.equal(parseWeeklySchedule([]).ok, false);
  assert.equal(parseWeeklySchedule("mon 9-5").ok, false);
  assert.equal(parseWeeklySchedule({ mon: "09:00-17:00" }).ok, false);
});

// ============================================================
// What the validator accepts, the reader must understand
// ============================================================

test("anything stored is a rota presence.ts can actually read", () => {
  // The two must agree, or validation just moves the silence later: a window
  // accepted here and not understood there is an employee who saves a rota and
  // is still never available.
  const result = parseWeeklySchedule({ mon: [{ start: "09:00", end: "17:00" }] });
  assert.equal(result.ok, true);
  const employee = {
    id: "e1",
    fullName: "Test",
    isActive: true,
    timezone: "Asia/Dubai",
    workingHours: result.schedule,
    breakSchedule: {},
    twinEnabled: true,
  };
  // 2026-08-17 is a Monday. 10:00 Dubai is inside the window.
  assert.equal(isScheduledAt(employee, new Date("2026-08-17T10:00:00.000+04:00")), true);
  assert.equal(isScheduledAt(employee, new Date("2026-08-17T18:00:00.000+04:00")), false);
});

test("a night shift wrapping midnight is counted, not treated as negative", () => {
  // windowContains treats end <= start as wrapping, so the hours total has to
  // as well — otherwise a 22:00–06:00 shift reads as minus sixteen hours and the
  // screen tells an operator their rota is empty when it is not.
  assert.equal(weeklyHours({ mon: [{ start: "22:00", end: "06:00" }] }), 8);
});

// ============================================================
// The writer, and the boundary around it
// ============================================================

test("there is a writer at all, and validation runs before it", () => {
  assert.match(DB, /export async function updateEmployeeSchedule/);
  assert.match(ROUTE, /parseWeeklySchedule/);
  const handler = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/schedule"'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.ok(
    body.indexOf("parseWeeklySchedule") < body.indexOf("updateEmployeeSchedule"),
    "a rota must be validated before it is stored"
  );
});

test("one business cannot edit another's rota", () => {
  // The path carries a :slug that requireTenantScope pins to the session, but
  // the employeeId does not — so without this check an id from another business
  // would be honoured, and the response would look entirely ordinary.
  const handler = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/schedule"'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.match(body, /employee\.organizationId !== organization\.id/);
  assert.match(body, /Employee not found/);
});

test("the timezone travels with the rota", () => {
  // "09:00–17:00" is not a fact until you know whose morning. Storing hours
  // without the zone they were meant in is how a Dubai rota gets evaluated in
  // UTC and reads as four hours out — a wrong answer that looks right.
  assert.match(DB, /timezone       = coalesce\(\$4, timezone\)/);
  assert.match(EDITOR, /timezone/);
});

test("a rota totalling zero hours is surfaced, not just stored", () => {
  // The whole point. This state produces no error anywhere — the person simply
  // is never offered — so it has to be said out loud in three places: the API
  // log, the list, and the editor.
  assert.match(ROUTE, /not bookable and will not be offered for escalation/);
  assert.match(ROUTE, /weeklyHours: weeklyHours\(employee\.workingHours\)/);
  assert.match(EDITOR, /0 hours — not bookable/);
  const LIST = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");
  assert.match(LIST, /no hours set/);
  console.log("PASS: a rota can be set, is validated, and an empty one is visible");
});

// ============================================================
// Staff setting their OWN hours (self-service)
// ============================================================

const MY_DESK = read("apps", "api", "src", "routes", "my-desk.ts");
const STAFF_PANEL = read("apps", "web", "app", "deck", "my-clients", "working-hours.tsx");

test("a staff member has a self-scoped schedule endpoint, keyed off the session", () => {
  // The owner's editor takes an :employeeId in the URL and can set anyone's in
  // the business. The staff one must NOT — it edits only the caller's own, so it
  // is reached through deskOf(c) (the session), never a colleague's id.
  assert.match(MY_DESK, /myDeskRoute\.get\("\/schedule"/);
  assert.match(MY_DESK, /myDeskRoute\.patch\("\/schedule"/);
  const patch = MY_DESK.slice(MY_DESK.indexOf('myDeskRoute.patch("/schedule"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /const desk = deskOf\(c\)/);
  assert.match(body, /updateEmployeeSchedule\(desk\.employeeId/);
  // No employee id is read from the request — the only id used is the session's.
  assert.ok(
    !/param\("employeeId"\)/.test(body),
    "the staff schedule endpoint reads an employee id from the request instead of the session"
  );
});

test("the staff endpoint validates the rota the same way the owner's does", () => {
  // Same jsonb-accepts-anything trap. A staff member typing a backwards window
  // must be refused on the way in, not left silently unbookable.
  const patch = MY_DESK.slice(MY_DESK.indexOf('myDeskRoute.patch("/schedule"'));
  assert.match(patch, /parseWeeklySchedule\(body\.workingHours\)/);
  assert.match(patch, /if \(!parsed\.ok\)/);
});

test("the staff panel says out loud when a saved rota is zero hours", () => {
  // Off-shift is a state you can choose here, so it must be visible — the whole
  // reason weeklyHours is surfaced rather than inferred from an empty diary.
  assert.match(STAFF_PANEL, /off-shift/i);
  assert.match(STAFF_PANEL, /saveMySchedule/);
});
