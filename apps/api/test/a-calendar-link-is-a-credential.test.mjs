/**
 * Calendar presence: the two things that would be quietly dangerous.
 *
 * The parser is proved against real calendar text in
 * a-calendar-that-half-parses. This file is about everything around it, and
 * there are two properties worth more than the rest.
 *
 * ONE: a published iCal link is bearer access to somebody's diary. Whoever
 * holds it reads every event title, attendee and location, with no sign-in and
 * no way for the owner to see who is reading. It goes in and must never come
 * back out — which is the opposite of what a settings form naturally does.
 *
 * TWO: a failed sync must not empty anybody's diary. A feed unreachable for an
 * hour would otherwise make the person look free all afternoon, and the agent
 * would promise them to a customer. Stale busy time is wrong in the safe
 * direction; absent busy time is wrong in the direction that ends with nobody
 * answering — which is the §9.5 failure this platform keeps closing doors on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hostOf } from "@nexus/db";
import { resolvePresence } from "@nexus/employees";
import { SCHEDULED_JOBS, JOB_STALE_AFTER_SECONDS } from "@nexus/shared";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "calendars.ts");
const SYNC = withoutComments(read("apps", "api", "src", "services", "calendar-sync.ts"));
const ROUTE = withoutComments(read("apps", "api", "src", "routes", "employees.ts"));
const PANEL = withoutComments(read("apps", "web", "app", "deck", "team", "calendar-link.tsx"));
const AVAILABILITY = withoutComments(read("apps", "api", "src", "services", "availability.ts"));
const CLIENT = read("apps", "web", "lib", "api.ts");

// ============================================================
// One: the link never comes back out
// ============================================================

test("the record a screen receives carries the host, never the address", () => {
  // The type is the enforcement. A field that does not exist cannot be
  // rendered into an input by somebody being helpful.
  const at = DB.indexOf("export interface CalendarRecord");
  assert.ok(at > -1, "CalendarRecord is gone");
  const shape = DB.slice(at, DB.indexOf("}", at));
  assert.ok(shape.includes("host: string"));
  assert.ok(!shape.includes("icsUrl"), "the calendar record carries the secret address");
  assert.ok(!shape.includes("ics_url"), "the calendar record carries the secret address");

  // And the same on the browser's copy of the type.
  const clientAt = CLIENT.indexOf("export interface CalendarRecord");
  assert.ok(clientAt > -1);
  const clientShape = CLIENT.slice(clientAt, CLIENT.indexOf("}", clientAt));
  assert.ok(!clientShape.includes("icsUrl"), "the browser's type carries the secret address");
});

test("only one function returns the address, and only the sync calls it", () => {
  // Named so a call site handing it to a response is visible in review.
  assert.ok(DB.includes("listCalendarsForSync"), "the sync-only reader is gone");
  assert.ok(
    SYNC.includes("listCalendarsForSync()"),
    "the sync no longer reads calendars through the one function that returns the URL"
  );
  assert.ok(
    !ROUTE.includes("listCalendarsForSync"),
    "a route reads the URL-bearing function — that address must not reach a response"
  );
});

test("the panel never pre-fills the field with what was saved", () => {
  // A settings form usually renders its stored value back. Here that would put
  // bearer access to a diary into any screenshot of the page.
  assert.ok(PANEL.includes('const [url, setUrl] = useState("")'), "the field is seeded from state");
  assert.ok(
    !PANEL.includes("calendar.icsUrl") && !PANEL.includes("calendar?.icsUrl"),
    "the panel reads an address the server does not send, or would render one if it did"
  );
});

test("what gets logged is the host, not the link", () => {
  // A log line is copied into a ticket far more casually than a database row.
  const at = ROUTE.indexOf('"A calendar was connected"');
  assert.ok(at > -1, "connecting a calendar is no longer recorded at all");
  const line = ROUTE.slice(ROUTE.lastIndexOf("logger.info", at), at);
  assert.ok(line.includes("host:"), "the log does not say which calendar");
  assert.ok(!line.includes("icsUrl"), "the secret address is being logged");
});

test("a pasted address is checked for safety before it is stored", () => {
  // Same class of input as a knowledge-base URL: somebody can paste
  // http://169.254.169.254/ and turn this platform into a proxy for its own
  // metadata service. Checked at PASTE time so the person is still looking at
  // the screen, rather than a quarter of an hour later on a page they closed.
  const at = ROUTE.indexOf('employeesRoute.put("/:slug/employees/:employeeId/calendar"');
  assert.ok(at > -1, "the connect route is gone");
  const body = ROUTE.slice(at, ROUTE.indexOf('employeesRoute.delete("/:slug/employees/:employeeId/calendar"', at));
  const guardAt = body.indexOf("assertPublicUrl");
  const storeAt = body.indexOf("connectCalendar(");
  assert.ok(guardAt > -1, "a pasted URL is stored without any address check");
  assert.ok(guardAt < storeAt, "the address is stored before it is checked");

  // And the guard is the one the knowledge connector already uses, not a
  // second copy that has to be kept right separately.
  assert.ok(ROUTE.includes('from "@nexus/knowledge"'));
});

// ============================================================
// Two: a failure must not empty a diary
// ============================================================

test("a sync that fails records why and leaves the busy time alone", () => {
  assert.ok(SYNC.includes("recordCalendarError("), "a failure is not recorded anywhere a person reads");

  // The catch must not clear anything. `replaceBusy` is only ever reached with
  // a calendar that was actually read.
  const catchAt = SYNC.indexOf("} catch (err) {");
  assert.ok(catchAt > -1);
  const handler = SYNC.slice(catchAt, SYNC.indexOf("logger.warn", catchAt));
  assert.ok(!handler.includes("replaceBusy"), "a failed sync empties the diary it could not read");
});

test("the error is stored, not only logged", () => {
  // The person who pasted a link that has since been revoked is the only one
  // who can rotate it, and they read a screen rather than a container log.
  assert.ok(DB.includes("export async function recordCalendarError"));
  assert.ok(DB.includes("set last_error = $2"), "the reason is not persisted");
  assert.ok(PANEL.includes("calendar.lastError"), "the screen never shows why a sync failed");
});

test("busy time is replaced wholesale rather than merged", () => {
  // A merge would have to notice events DELETED from the calendar since last
  // time, and a deletion that goes unnoticed leaves somebody blocked for a
  // meeting that is not happening.
  const at = DB.indexOf("export async function replaceBusy");
  assert.ok(at > -1);
  const fn = DB.slice(at, DB.indexOf("export async function recordCalendarError"));
  assert.ok(fn.includes("delete from calendar_busy where employee_id = $1"));
  assert.ok(fn.includes('await pool.query("begin")'), "the replace is not atomic");
  assert.ok(fn.includes('rollback'), "a partial replace can survive a failure");
});

// ============================================================
// What it may and may not conclude about a person
// ============================================================

const employee = (over = {}) => ({
  isActive: true,
  timezone: "UTC",
  manualPresence: null,
  manualPresenceUntil: null,
  workingHours: { mon: [{ start: "09:00", end: "17:00" }] },
  breakSchedule: {},
  twinEnabled: false,
  humanFirst: false,
  ...over,
});

// A Monday, inside the window above.
const MONDAY_NOON = new Date("2026-08-24T12:00:00Z");
const MONDAY_EVENING = new Date("2026-08-24T20:00:00Z");

test("a meeting inside working hours makes somebody busy, not offline", () => {
  // Busy and offline are different answers: one means "here but occupied", the
  // other means "not here". The escalation path treats them differently.
  const free = resolvePresence(employee(), MONDAY_NOON, false);
  assert.equal(free.status, "online");

  const inMeeting = resolvePresence(employee(), MONDAY_NOON, true);
  assert.equal(inMeeting.status, "busy");
  assert.equal(inMeeting.source, "calendar");
  assert.match(inMeeting.reason, /calendar/i);
});

test("a calendar cannot make somebody available outside their hours", () => {
  // An evening meeting is evidence somebody is busy. It is never evidence they
  // are at work, and treating it that way would let a diary silently extend a
  // rota.
  const out = resolvePresence(employee(), MONDAY_EVENING, true);
  assert.equal(out.status, "offline");
  assert.match(out.reason, /Outside working hours/);
});

test("a person who says they are available outranks their diary", () => {
  // They are looking at both and this is not.
  const override = employee({
    manualPresence: "online",
    manualPresenceUntil: new Date(MONDAY_NOON.getTime() + 3_600_000).toISOString(),
  });
  const out = resolvePresence(override, MONDAY_NOON, true);
  assert.equal(out.status, "online");
  assert.equal(out.source, "manual");
});

test("presence stays pure — the busy state is passed in, never fetched", () => {
  // It runs on every inbound message. The whole point of it being synchronous
  // is that it never touches the database.
  const PRESENCE = withoutComments(read("packages", "employees", "src", "presence.ts"));
  for (const forbidden of ["getPool", "await ", "async function resolvePresence"]) {
    assert.ok(!PRESENCE.includes(forbidden), `presence.ts reaches for ${forbidden}`);
  }
});

test("the promise path reads the calendar in the SERVING business's context", () => {
  // The signature failure of this codebase, eleven times over: a read for the
  // serving business from inside the number owner's transaction returns zero
  // rows under RLS rather than an error, and zero rows here means "nobody is
  // in a meeting", which is the generous direction.
  const at = AVAILABILITY.indexOf("export async function hasStaffOnShift");
  assert.ok(at > -1);
  const fn = AVAILABILITY.slice(at, AVAILABILITY.indexOf("return false;", at));
  const wrapAt = fn.indexOf("withServingTenant");
  const readAt = fn.indexOf("busyEmployeeIds");
  assert.ok(wrapAt > -1 && readAt > -1, "the calendar is not consulted when deciding to promise");
  assert.ok(wrapAt < readAt, "the calendar is read outside the serving business's context");
});

test("a calendar that has never synced blocks nobody", () => {
  // The default has to be generous in THIS direction: a business with no
  // calendars connected must behave exactly as it did before this existed.
  // The CALL, not the import line above it — which is what the first version of
  // this found, and it passed for the wrong reason until the assertion window
  // happened to be too small.
  const at = AVAILABILITY.indexOf("busyEmployeeIds(");
  assert.ok(at > -1, "the calendar is not consulted at all");
  const around = AVAILABILITY.slice(at, at + 220);
  assert.ok(
    around.includes("catch(") && around.includes("new Set<string>()"),
    "a calendar read that fails must not make everybody available or everybody busy"
  );
});

// ============================================================
// The sync is watched like every other job
// ============================================================

test("the sync is a scheduled job with a tolerance, so its silence is noticed", () => {
  // A dead calendar sync does not look like an outage from any screen: everyone
  // simply stays as free as they were a fortnight ago, and the agent goes on
  // promising them.
  assert.ok(SCHEDULED_JOBS.includes("calendar-sync"), "the sync is unwatched");
  assert.ok(JOB_STALE_AFTER_SECONDS["calendar-sync"] > 0, "nothing can call the sync late");
  assert.ok(
    JOB_STALE_AFTER_SECONDS["calendar-sync"] < JOB_STALE_AFTER_SECONDS["quality-rollup"],
    "a stale calendar changes what a customer is told and should be noticed sooner than a rollup"
  );
});

test("every database read in the sync declares which tenants it is for", () => {
  // FOUND IN PRODUCTION ON THE FIRST CYCLE, 2026-08-25. listCalendarsForSync
  // reads every business's feeds by design and was wrapped in nothing, so
  // DB_TENANT_ASSERT=strict threw — which is the assert doing its job. Without
  // it the query would have returned zero rows under RLS and this would have
  // reported a clean sync of nothing, forever, with every diary silently empty.
  //
  // The class, not the instance: EVERY db call in this file must sit inside a
  // wrapper, so the next one added is caught by the same assertion.
  const calls = ["listCalendarsForSync(", "replaceBusy(", "recordCalendarError("];
  for (const call of calls) {
    const at = SYNC.indexOf(call);
    assert.ok(at > -1, `${call} is gone from the sync`);
    // Look backwards for the nearest wrapper. Both are legitimate here and they
    // mean different things: withTenant for one business's rows, withAllTenants
    // for the sweep that reads them all.
    const before = SYNC.slice(Math.max(0, at - 300), at);
    assert.ok(
      before.includes("withAllTenants(") || before.includes("withTenant("),
      `${call} runs with no tenant context — under RLS it returns zero rows rather than an error`
    );
  }

  // And the cross-tenant one says WHY in words, which is the whole reason that
  // wrapper takes a reason.
  assert.ok(
    SYNC.includes('withAllTenants(' ) && SYNC.includes("calendar sync reads every business"),
    "the deliberate cross-tenant read must state its reason"
  );
});

test("hostOf never throws on something already in the database", () => {
  assert.equal(hostOf("https://calendar.google.com/calendar/ical/x/basic.ics"), "calendar.google.com");
  assert.equal(hostOf("nonsense"), "an unreadable address");
  assert.equal(hostOf(""), "an unreadable address");
});
