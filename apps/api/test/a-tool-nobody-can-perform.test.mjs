/**
 * A business with nobody on a rota must not be handed a booking tool.
 *
 * On 2026-08-24 three of the four businesses with `book_appointment` enabled
 * could not have taken an appointment: ABR and Juris Prime Legal have no
 * employees at all, and SFS International has three with not one day of rota
 * between them. The operators had been reporting it per business since 20
 * August — "The agent offers appointments nobody can take" — and the model was
 * still being given the tool.
 *
 * These are source-level assertions because the alternative is standing up an
 * agent, a model client and five tenants to observe one array being filtered.
 * They are written knowing exactly how that goes wrong: an assertion satisfied
 * by the comment explaining it, or a marker that stops matching and turns the
 * test into a tautology. Every `indexOf` here is checked for -1 first, and
 * every phrase asserted is checked against the code with comments stripped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { proseOf, withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const SWITCHBOARD = read("packages", "agents", "src", "switchboard.ts");
const AVAILABILITY = read("packages", "agents", "src", "availability.ts");

const code = (src) => withoutComments(src);

/** indexOf, with the -1 that silently makes every comparison true ruled out. */
const at = (src, marker, label) => {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `${label} no longer contains ${JSON.stringify(marker)} — this test is not testing anything`);
  return i;
};

test("the rota question is asked of the schedule reader, not of the jsonb", () => {
  // One notion of a working week, not two. A rota of {"mon": []} is not empty
  // and is also not a rota, and only isScheduledAt knows that. Asserted against
  // the code rather than the file, so the paragraph above cannot satisfy it.
  const body = code(AVAILABILITY);
  assert.ok(body.includes("isScheduledAt("), "hasAnyoneOnARota must read the same schedule function availability does");
  assert.ok(
    !body.includes("working_hours <> "),
    "inspecting the jsonb directly would be a second notion of a working week"
  );
});

test("hasAnyoneOnARota is not the same question as having a free slot", () => {
  // A business whose week is fully booked HAS a rota and must keep its booking
  // tools -- it should say "no availability", which is true. Only a business
  // that has never said when anyone works loses them.
  const body = code(AVAILABILITY);
  const start = at(body, "export async function hasAnyoneOnARota", "availability.ts");
  const fn = body.slice(start, start + 900);
  assert.ok(
    !fn.includes("listBookingsInWindow") && !fn.includes("findAvailableSlots"),
    "a booked diary is not an absent rota; this must not consult bookings"
  );
});

test("every agent constructor gets the same filter", () => {
  // Three of them, and the reason this is asserted rather than trusted is that
  // the shared-number config bug was exactly a path somebody forgot.
  // The PROPERTY, not the arithmetic. The first version of this counted call
  // sites and required filtered === constructed + 1, which broke the moment
  // effectiveToolsFor was added as a legitimate fourth caller — a test that
  // fails when correct code is added is a test that gets its numbers bumped
  // until it means nothing.
  const body = code(SWITCHBOARD);
  const sites = [...body.matchAll(/new AnthropicDomainAgent\(/g)];
  assert.ok(sites.length >= 3, `expected the three agent constructors, found ${sites.length}`);

  for (const site of sites) {
    const open = body.indexOf("(", site.index + "new AnthropicDomainAgent".length);
    let depth = 0;
    let close = open;
    for (; close < body.length; close++) {
      if (body[close] === "(") depth++;
      else if (body[close] === ")" && --depth === 0) break;
    }
    const args = body.slice(open, close + 1);
    assert.ok(
      args.includes("withoutUnperformableTools("),
      `an agent is constructed without the tool filter: ${args.slice(0, 70)}`
    );
  }
});

test("the filter fails open", () => {
  const body = code(SWITCHBOARD);
  const start = at(body, "async function withoutUnperformableTools", "switchboard.ts");
  const fn = body.slice(start, start + 800);
  assert.ok(
    fn.includes(".catch(() => true)"),
    "a rota lookup that throws must leave the tools in place, not silently disable booking"
  );
});

test("both booking tools are covered, and nothing else is", () => {
  const body = code(SWITCHBOARD);
  const start = at(body, "TOOLS_NEEDING_A_ROTA = new Set(", "switchboard.ts");
  const decl = body.slice(start, body.indexOf(")", start));
  assert.ok(decl.includes("check_availability"), "offering to look needs a rota too, not just booking");
  assert.ok(decl.includes("book_appointment"));
  assert.ok(!decl.includes("search_knowledge"), "knowledge does not need anybody on a rota");
  assert.ok(!decl.includes("check_inventory"), "inventory does not need anybody on a rota");
});

test("the rota read widens itself for the serving business", () => {
  // The twelfth instance would have been free here: hasAnyoneOnARota runs on the
  // reply path, inside the NUMBER OWNER's transaction, asking about a SERVING
  // business. It is safe only because listEmployees widens itself -- so that is
  // what is asserted, in the file that would break it.
  const employees = read("packages", "db", "src", "employees.ts");
  const body = code(employees);
  const start = at(body, "export async function listEmployees(", "employees.ts");
  const fn = body.slice(start, start + 300);
  assert.ok(
    fn.includes("withServingTenant("),
    "listEmployees must widen for the serving business, or every routed business loses booking"
  );
});

test("the reason is recorded where somebody will hit it", () => {
  // Not a style check. The next person to see a business lose its booking tools
  // will look here first, and "three of the four businesses" is the fact that
  // makes it obviously deliberate rather than obviously broken.
  // Whitespace collapsed first, because comments are WRAPPED PROSE and a phrase
  // that fits on one line today sits across two the moment somebody edits the
  // sentence before it. The first version of this assertion looked for the
  // finding's name and failed on a line break in the middle of it — a test that
  // would go red for reformatting is a test people delete.
  const prose = proseOf(AVAILABILITY);
  assert.ok(
    prose.includes("The agent offers appointments nobody can take"),
    "hasAnyoneOnARota should name the operator finding it answers"
  );
});
