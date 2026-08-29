/**
 * A screen that asked for work instead of showing it.
 *
 * ============================================================
 * THE GREETING THAT PRINTED A LOGIN
 * ============================================================
 *
 * A staff member's front page opened with "Welcome back,
 * aiapps255+staff@gmail.com." The session carries a SUBJECT — an email — and
 * the page treated it as a name. Below it: an empty list and a form.
 *
 * None of that is broken in a way anything could catch. The page rendered, the
 * form worked, the list was correctly empty. It simply never answered the
 * question a person opens a console with: what needs me, and in what order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DAY_API = read("apps", "api", "src", "routes", "my-day.ts");
const DAY_UI = read("apps", "web", "app", "my-day.tsx");
const HOME = read("apps", "web", "app", "page.tsx");
const WORKSPACE = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");

// ============================================================
// The name
// ============================================================

test("the greeting uses a name, never the login", () => {
  // The session's `sub` is an email. Printing it as a name is the defect this
  // whole screen was rebuilt around.
  assert.match(DAY_API, /fullName: employee\.fullName/);
  assert.match(DAY_UI, /who\.firstName/);
  assert.ok(
    !/lockedTo\.fullName/.test(WORKSPACE),
    "the workspace is printing the session subject as a name again"
  );
});

test("the old page no longer greets at all", () => {
  // Two greetings on one screen, one of them wrong, is worse than one.
  //
  // Asserted against the RENDERED heading, not the whole file. The first
  // version searched the source for "Welcome back" and failed on the comment
  // that explains why the greeting was removed -- a test that forbids
  // describing the bug it guards against.
  const heading = WORKSPACE.slice(WORKSPACE.indexOf("<h1>"), WORKSPACE.indexOf("</h1>"));
  assert.ok(!/Welcome back/.test(heading), "the heading greets again");
  assert.match(heading, /Your customers/);
});

// ============================================================
// Scope
// ============================================================

test("everything is keyed on the session's employee, never the caller's", () => {
  assert.match(DAY_API, /deskOf\(c\)/);
  assert.match(DAY_API, /employeeId: desk\.employeeId/);
  assert.ok(
    !/c\.req\.(param|query)\("employee/.test(DAY_API),
    "an employee id is being taken from the request"
  );
});

test("an operator gets the same refusal as everywhere else under /my", () => {
  // They have no employee record, so there is no day to show them.
  assert.match(DAY_API, /403/);
});

// ============================================================
// "Waiting" is a claim about the last message
// ============================================================

test("waiting means the customer spoke last, not that a row exists", () => {
  // The tempting query is "open conversations assigned to me", which counts
  // every thread anybody ever handed over, most of them finished. The useful
  // question is whether the most recent message came FROM the customer.
  const fn = DAY_API.slice(DAY_API.indexOf("async function waitingOnMe"));
  assert.match(fn, /m\.direction = 'inbound'/);
  assert.match(fn, /order by created_at desc\s*\n\s*limit 1/);
});

test("the queue is oldest first", () => {
  // Newest-first shows the person who has waited least, which is the wrong end
  // of a queue and the default a sort usually lands on.
  const fn = DAY_API.slice(DAY_API.indexOf("async function waitingOnMe"));
  assert.match(fn, /order by m\.created_at asc/);
});

test("waiting is scoped to the serving business, not the row's owner", () => {
  // On a shared number a conversation's organization_id is the number owner's.
  const fn = DAY_API.slice(DAY_API.indexOf("async function waitingOnMe"));
  assert.match(fn, /coalesce\(c\.routed_organization_id, c\.organization_id\) = \$1/);
});

// ============================================================
// The order on the screen is the argument
// ============================================================

test("people waiting come before follow-ups, appointments and suggestions", () => {
  // Ordered by who is inconvenienced if it is missed. Somebody holding their
  // phone outranks a task with a date on it.
  const waiting = DAY_UI.indexOf("Waiting for you");
  const tasks = DAY_UI.indexOf("Your follow-ups");
  const booked = DAY_UI.indexOf("Coming up");
  assert.ok(waiting > -1 && tasks > waiting, "follow-ups now come before waiting customers");
  assert.ok(booked > tasks, "appointments now come before follow-ups");
});

test("an appointment renders in the business's timezone", () => {
  // An appointment is a time somebody physically arrives somewhere. The
  // reader's zone would show an hour they then repeat to the customer.
  assert.match(DAY_UI, /timeZone: booking\.timezone/);
  assert.match(DAY_API, /timezone: booking\.businessTimezone/);
});

test("nothing to do is stated, not left blank", () => {
  // A screen of empty skeletons makes somebody scan to discover nothing needs
  // them. One line is faster and truer.
  assert.match(DAY_UI, /You are clear/);
});

// ============================================================
// The nudges
// ============================================================

test("a nudge only appears when it is actionable", () => {
  // Every one is behind a condition. A nudge that shows when there is nothing
  // to do is what teaches people to stop reading them.
  assert.match(DAY_API, /if \(!employee\.whatsappNumber\)/);
  assert.match(DAY_API, /if \(overdue\.length > 0\)/);
  assert.match(DAY_API, /neverSpoken\.length >= 3/);
});

test("the link nudge waits for the number nudge to be resolved", () => {
  // Telling somebody their link is unused while they have no number to hand
  // people to asks for the second step before the first is possible.
  const guard = DAY_API.slice(DAY_API.indexOf('kind: "link-unused"') - 400, DAY_API.indexOf('kind: "link-unused"'));
  assert.match(guard, /employee\.whatsappNumber/);
});

test("the missing-number nudge names the consequence, not the field", () => {
  // "Add your WhatsApp number" is a chore. "Customers cannot be handed to you"
  // is a reason.
  assert.match(DAY_API, /cannot be handed to you/);
});

// ============================================================
// Where it sits
// ============================================================

test("the day is rendered above the workspace, not instead of it", () => {
  // The lead form is genuinely useful and keeps its place; it was only ever
  // the wrong FIRST thing.
  const day = HOME.indexOf("<MyDay />");
  const workspace = HOME.indexOf("<TeamWorkspace");
  assert.ok(day > -1 && workspace > day, "the workspace no longer follows the day");
});
