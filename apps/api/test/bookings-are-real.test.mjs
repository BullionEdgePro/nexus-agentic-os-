// An appointment the agent makes has to be one somebody can keep.
//
// `book_appointment` was a stub for the whole life of this platform. It replied
// "a colleague will confirm the time", wrote nothing anywhere, and told nobody.
// A customer who agreed a consultation and a customer who never asked produced
// identical records — which is to say, none. Four of the five businesses ran on
// that, and every conversation read as a success.
//
// Replacing it introduces two new ways to be confidently wrong, and this file is
// about both:
//
//   1. Booking a time nobody works. The row is valid, the constraint is
//      satisfied, the conversation is fluent, and the customer arrives at a
//      locked door.
//   2. Booking a time somebody else already has. Two customers are each told
//      they have 3pm, nothing errors, and the employee finds two people waiting.
//
// The second cannot be prevented in JavaScript at all — see the constraint
// tests below — so what this file checks is that nobody has quietly moved it
// there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isScheduledAt, isScheduledThroughout } from "@nexus/employees";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const MIGRATION = read("packages", "db", "migrations", "031-bookings.sql");
const TOOLS_MIGRATION = read("packages", "db", "migrations", "032-enable-availability-tool.sql");
const BOOKINGS_DB = read("packages", "db", "src", "bookings.ts");
const AVAILABILITY = read("packages", "agents", "src", "availability.ts");
const TOOL = read("packages", "agents", "src", "tools", "bookings.ts");
const EXAMPLES = read("packages", "agents", "src", "tools", "examples.ts");
const ROUTE = read("apps", "api", "src", "routes", "bookings.ts");
const SELF_CHECK = read("apps", "api", "src", "scripts", "self-check.ts");
const SEED = read("packages", "db", "seed.sql");

// ============================================================
// 1. The guarantee lives in the database
// ============================================================

test("double-booking is prevented by a constraint, not by application code", () => {
  // The obvious implementation — read the diary, see the slot is free, insert —
  // is a race with no error in it. Both customers read an empty slot, both are
  // told they have it, and the only artefact is two people in a waiting room.
  assert.match(MIGRATION, /exclude using gist/);
  assert.match(MIGRATION, /employee_id with =/);
  assert.match(MIGRATION, /tstzrange\(starts_at, ends_at\) with &&/);
  // btree_gist is what makes the `employee_id with =` half legal at all. Without
  // it the constraint does not install, and a migration that failed to install a
  // constraint leaves a table that accepts everything.
  assert.match(MIGRATION, /create extension if not exists btree_gist/);
});

test("the constraint covers confirmed bookings only, so cancelling frees the slot", () => {
  // A constraint that never releases is a diary that fills up permanently: every
  // cancelled appointment would keep blocking its own time, and the business
  // would slowly become unbookable for reasons nobody could see.
  assert.match(MIGRATION, /where \(status = 'confirmed' and employee_id is not null\)/);
});

test("no availability check is smuggled back into the insert path", () => {
  // The defensive-looking regression: a read-then-write in front of the insert.
  // It cannot make anything safer — the constraint is already the guarantee —
  // and it would make the race look handled.
  const create = BOOKINGS_DB.slice(
    BOOKINGS_DB.indexOf("export async function createBooking"),
    BOOKINGS_DB.indexOf("export async function setBookingStatus")
  );
  assert.ok(create.length > 500, "the createBooking slice must not be empty");
  assert.ok(
    !/select[\s\S]*from bookings/i.test(create),
    "createBooking must not read the diary before writing — that is the race"
  );
  assert.match(
    create,
    /isDoubleBooking\(err\)/,
    "it must recognise the exclusion violation it relies on rather than swallowing it"
  );
});

test("a clash is a distinct error, not a string somebody matched on", () => {
  // The caller has to tell "that slot went" apart from every other failure,
  // because only one of them means "offer another time" rather than "something
  // is broken". A message match would break silently the first time the wording
  // changed.
  assert.match(BOOKINGS_DB, /export class SlotTakenError extends Error/);
  // Matched on the SQLSTATE and the constraint name together. The code alone
  // would catch any exclusion violation on any table and report somebody else's
  // problem as "that time has just been taken".
  assert.match(BOOKINGS_DB, /code === "23P01"/);
  assert.match(BOOKINGS_DB, /constraint === "bookings_no_double_booking"/);
  // Every write that can collide must map it. Assigning is the quiet one: it is
  // the moment an unassigned booking starts competing for somebody's time, and
  // it was easy to leave out.
  for (const fn of ["createBooking", "setBookingStatus", "assignBooking"]) {
    const body = BOOKINGS_DB.slice(BOOKINGS_DB.indexOf(`export async function ${fn}`));
    const slice = body.slice(0, body.indexOf("\nexport ") === -1 ? body.length : body.indexOf("\nexport "));
    assert.match(slice, /SlotTakenError/, `${fn} must map an exclusion violation`);
  }
});

test("a cancellation is a status change, never a delete", () => {
  // A customer told 3pm who then finds nothing on record cannot tell a
  // cancellation from a system that lost their booking.
  assert.ok(!/delete from bookings/i.test(BOOKINGS_DB), "nothing in the data layer deletes a booking");
  assert.ok(!/\.delete\(|method: "DELETE"/.test(ROUTE), "the API exposes no delete");
  assert.match(MIGRATION, /check \(status in \('confirmed', 'cancelled', 'completed', 'no_show'\)\)/);
});

// ============================================================
// 2. A time is only offered when somebody is actually working
// ============================================================

const employee = (workingHours, breakSchedule = {}) => ({
  id: "emp-1",
  fullName: "Test Person",
  isActive: true,
  timezone: "Asia/Dubai",
  workingHours,
  breakSchedule,
  twinEnabled: true,
});

// 2026-08-17 is a Monday. All times below are Asia/Dubai (UTC+4).
const monday = (hhmm) => new Date(`2026-08-17T${hhmm}:00.000+04:00`);

test("somebody with no schedule is never bookable", () => {
  // The same deliberate choice hasStaffOnShift makes. A business that has not
  // said when anyone works cannot have appointments made in its name — offering
  // one means promising a time nobody has agreed to.
  assert.equal(isScheduledAt(employee({}), monday("10:00")), false);
});

test("an inactive employee is never bookable", () => {
  const person = { ...employee({ mon: [{ start: "09:00", end: "17:00" }] }), isActive: false };
  assert.equal(isScheduledAt(person, monday("10:00")), false);
});

test("a slot inside working hours is bookable", () => {
  const person = employee({ mon: [{ start: "09:00", end: "17:00" }] });
  assert.equal(isScheduledThroughout(person, monday("10:00"), monday("11:00")), true);
});

test("a slot that runs past closing is refused", () => {
  // THE BUG THIS EXISTS FOR. Checking only the start time sells the last half
  // hour before closing as a full consultation — the appointment is accepted,
  // the customer is told an hour, and the office shuts halfway through.
  const person = employee({ mon: [{ start: "09:00", end: "17:00" }] });
  assert.equal(isScheduledThroughout(person, monday("16:30"), monday("17:30")), false);
});

test("an appointment ending exactly at closing time is fine", () => {
  // The off-by-one on the other side. A shift to 17:00 must accept a slot that
  // ends at 17:00, or every business loses its last appointment of the day for
  // no reason anybody could explain.
  const person = employee({ mon: [{ start: "09:00", end: "17:00" }] });
  assert.equal(isScheduledThroughout(person, monday("16:00"), monday("17:00")), true);
});

test("a break in the middle of a slot refuses it", () => {
  // Sampling, not endpoint-checking. Both ends of 12:30–13:30 fall outside a
  // 12:45–13:15 break, so anything that only looked at the ends would book
  // straight through somebody's lunch.
  const person = employee(
    { mon: [{ start: "09:00", end: "17:00" }] },
    { mon: [{ start: "12:45", end: "13:15" }] }
  );
  assert.equal(isScheduledThroughout(person, monday("12:30"), monday("13:30")), false);
  assert.equal(isScheduledThroughout(person, monday("14:00"), monday("15:00")), true);
});

test("working hours are read in the employee's own timezone", () => {
  // 06:00 UTC is 10:00 in Dubai. Evaluated in UTC this would fall outside a
  // 09:00–17:00 shift and the business would appear closed all morning — which
  // is a wrong answer that looks exactly like a correct one.
  const person = employee({ mon: [{ start: "09:00", end: "17:00" }] });
  assert.equal(isScheduledAt(person, new Date("2026-08-17T06:00:00.000Z")), true);
  assert.equal(isScheduledAt(person, new Date("2026-08-17T02:00:00.000Z")), false);
});

test("scheduling reads the rota, never the manual presence override", () => {
  // resolvePresence answers "is this person free NOW" and consults the manual
  // override first — correct for right-now, meaningless for next Thursday.
  // Booking against it would let somebody's two-day "busy" flag block a month of
  // appointments, and a one-hour "online" flag open a year of them.
  const scheduled = AVAILABILITY.slice(0);
  assert.ok(
    !/resolvePresence/.test(scheduled),
    "availability must not resolve present-tense presence"
  );
  const presence = read("packages", "employees", "src", "presence.ts");
  const fn = presence.slice(presence.indexOf("export function isScheduledAt"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(!/manualPresence/.test(body), "isScheduledAt must ignore the manual override");
});

// ============================================================
// 3. The agent cannot invent a time
// ============================================================

test("the two tools are shipped together, or the agent guesses", () => {
  // book_appointment's own description tells the model to call
  // check_availability first. A business given one without the other has an
  // agent that is instructed to check, finds no such tool, and books from its
  // own idea of opening hours.
  assert.match(TOOL, /name: "check_availability"/);
  assert.match(TOOL, /name: "book_appointment"/);
  assert.match(TOOLS_MIGRATION, /check_availability/);
  assert.match(TOOLS_MIGRATION, /raise exception/, "the migration must refuse to leave them out of step");

  // A fresh install must not be born in the broken state the migration exists to
  // repair.
  const configs = SEED.match(/'\[[^\]]*book_appointment[^\]]*\]'/g) ?? [];
  assert.ok(configs.length >= 4, `expected the booking tenants in the seed, found ${configs.length}`);
  for (const config of configs) {
    assert.match(config, /check_availability/, `seed config can book but not check: ${config}`);
  }
});

test("the stub is gone, not merely bypassed", () => {
  // The old handler returned booked:false / captured:true and told the model to
  // promise a human confirmation. Left registered, it would win or lose the
  // registry race by import order — and the losing outcome is the silent one.
  assert.ok(!/captured: true/.test(EXAMPLES), "the stub handler must not still be registered");
  assert.ok(!/bookAppointmentTool/.test(EXAMPLES.slice(EXAMPLES.indexOf("defaultToolRegistry.register"))));
});

test("the model is told that booked:false means no appointment exists", () => {
  // The failure this platform keeps producing is a fluent wrong answer. The one
  // sentence that matters here is the one forbidding the model to confirm a
  // booking that did not happen.
  assert.match(TOOL, /Only tell the customer the appointment is confirmed when this returns[\s\S]{0,40}booked: true/);
  assert.match(TOOL, /Do not say the appointment was made/);
  assert.match(TOOL, /Never invent or estimate a time/);
});

test("the reply pipeline hands the agent a real customer to book against", () => {
  // ToolContext carries contactId and conversationId as OPTIONAL, because
  // dry-run-reply genuinely has neither — it probes an agent with a reserved
  // wa_id and must not put a fake customer in a real business's records. That
  // optionality is what makes this assertion necessary: if the live pipeline
  // ever stopped passing them, nothing would fail to compile, and every booking
  // attempt would take the no_contact branch and quietly go back to promising a
  // human follow-up. Which is exactly the stub's behaviour, restored by
  // accident, and indistinguishable from it in the conversation.
  const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
  const call = PROCESSOR.slice(
    PROCESSOR.indexOf("const result = await agent.respond("),
    PROCESSOR.indexOf("if (!result.text) return;")
  );
  assert.ok(call.length > 200, "the agent.respond slice must not be empty");
  assert.match(call, /\bcontactId,/, "the agent must be told which customer this is");
  assert.match(call, /\bconversationId,/, "the agent must be told which thread this is");
});

test("a booking with no customer is refused rather than guessed at", () => {
  // contact_id is NOT NULL, so the alternative to refusing is inventing one. A
  // booking filed against the wrong customer is worse than a booking not made:
  // it is a real appointment in a real diary, for the wrong person.
  assert.match(TOOL, /if \(!ctx\.contactId\)/);
  assert.match(TOOL, /reason: "no_contact"/);
  assert.match(MIGRATION, /contact_id uuid not null/);
});

test("every tool path fails soft, never by throwing", () => {
  // The version before the stub threw, and the raw internal string went back to
  // the model as a tool error with nothing stopping it being paraphrased to a
  // customer. Each handler must return a structured refusal instead.
  const handlers = TOOL.split("handler: async").slice(1);
  assert.equal(handlers.length, 2, "expected two tool handlers");
  for (const handler of handlers) {
    assert.match(handler, /catch/, "a handler with no catch can reach the model as a raw error");
  }
  assert.ok(!/throw new Error/.test(TOOL), "a tool handler must not throw at the model");
});

// ============================================================
// 4. Scoping — the part that was invisible
// ============================================================

test("the tool widens to the serving business before touching the diary", () => {
  // All five businesses share one WhatsApp number, so the reply pipeline's
  // transaction is scoped to the number's OWNER. A booking for the serving
  // business written in that context is refused by the RLS policy; a read comes
  // back empty. `withTenant` cannot help — nested, it deliberately reuses the
  // outer context and does nothing at all.
  assert.match(TOOL, /withServingTenant\(ctx\.organizationId/);
  assert.ok(
    !/withTenant\(ctx\.organizationId/.test(TOOL),
    "withTenant nested inside the owner's context is a no-op, not a scope"
  );
  assert.match(AVAILABILITY, /MUST BE CALLED IN THE SERVING BUSINESS'S TENANT CONTEXT/);
});

test("widening is checked against the data, not taken on trust", () => {
  // Otherwise this is a general-purpose way out of RLS with a reassuring name.
  // The two businesses must genuinely share a number, verified by query, or the
  // switch is refused.
  const CLIENT = read("packages", "db", "src", "client.ts");
  const fn = CLIENT.slice(CLIENT.indexOf("export async function withServingTenant"));
  const body = fn.slice(0, fn.indexOf("\n/**"));
  assert.match(body, /owner\.whatsapp_phone_number_id = serving\.whatsapp_phone_number_id/);
  assert.match(body, /Refusing to widen tenant scope/);
  // Restored on the throw path too — otherwise the rest of the owner's
  // transaction silently runs as somebody else.
  assert.match(body, /\} finally \{/);
});

test("an employee cannot reach another business's diary", () => {
  // /api/bookings carries no :slug, so requireTenantScope does not apply and the
  // request runs cross-tenant. If this handler forgets, an employee reads five
  // businesses' customers, phone numbers and where they will be — and the
  // response looks entirely normal.
  assert.match(ROUTE, /scope\.role === "operator"/);
  assert.match(ROUTE, /Your account is not attached to a business/);
  // Mutations carry the constraint into the query rather than checking it in the
  // handler, matching tasks.ts — a caller-side check is one somebody forgets to
  // write on the next endpoint.
  assert.match(BOOKINGS_DB, /\$3::uuid is null or organization_id = \$3/);
});

test("the business is taken from the conversation, not from the caller", () => {
  // Every conversation on the shared number is OWNED by Zipicka while
  // routed_organization_id holds the business it was actually for. Reading the
  // wrong column files every appointment under the retailer: the law firm's
  // diary is empty, and nothing reports a fault.
  assert.match(BOOKINGS_DB, /coalesce\(routed_organization_id, organization_id\)/);
});

// ============================================================
// 5. The check that would catch a dropped constraint
// ============================================================

test("self-check proves the refusal, from separate committed transactions", () => {
  // If `bookings_no_double_booking` were dropped tomorrow, every assertion in
  // this file would still pass — they read source text, and the constraint is
  // not in the source. Only a live insert can tell.
  //
  // And it has to be two committed transactions. Two inserts inside one
  // transaction prove the constraint fires; they do not reproduce two customers
  // messaging at the same moment, which is two connections.
  assert.match(SELF_CHECK, /an overlapping booking is refused by the database/);
  assert.match(SELF_CHECK, /err instanceof SlotTakenError/);
  assert.match(SELF_CHECK, /cancelling frees the slot for somebody else/);
  // Cleanup keyed on a constant, never on an id a failure may have prevented
  // being assigned — createBooking can throw after its INSERT has committed.
  assert.match(SELF_CHECK, /delete from bookings where organization_id = \$1 and subject = \$2/);
  assert.match(SELF_CHECK, /probe appointments removed/);
  console.log("PASS: an appointment the agent makes is one somebody can keep");
});
