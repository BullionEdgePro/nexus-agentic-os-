// The argument was corrected, a test locked it, and the answer was still wrong.
//
// `processor.ts` asks `hasActiveEmployees` on the stale-handoff release path.
// It used to ask about `organization.id` — the number's OWNER — which meant the
// release could never fire for the four businesses that share Zipicka's number.
// That was found on 2026-08-17, corrected to `answering`, and locked by
// `stale-handoff-releases.test.mjs`, which asserts the argument by name and
// asserts the old one is gone.
//
// Both were true on 2026-08-19 and the read still returned nothing. On this
// platform naming the business is only half of asking about it: the query runs
// inside the owner's transaction, and RLS does not read the WHERE clause to
// decide what you may see. `hasActiveEmployees` was raw `getPool().query`, so
// it returned zero for every serving business regardless of the id passed in.
//
// The failure direction is the opposite of the other five instances of this
// defect, and worse. They return nothing, and a customer is told nothing. This
// returns FALSE — "this business has no staff at all" — and the pipeline acts
// on it, clearing a handoff flag a human is holding and putting the agent back
// on top of a live conversation.
//
// Latent when found: no routed conversation was in handoff, and the three that
// were belong to Zipicka, which owns the number, so the read was in scope by
// coincidence of who was asking. Juris Prime has an active employee, so the
// first routed handoff would have fired it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const EMPLOYEES = read("packages", "db", "src", "employees.ts");

/** One exported reader's body, so an assertion cannot match its neighbour. */
function body(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\nexport async function |\nasync function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("both employee readers widen to the serving business themselves", () => {
  for (const name of ["listEmployees", "hasActiveEmployees"]) {
    // Substring rather than a built regex. The first version of this assembled
    // the pattern with `new RegExp` inside a template literal, where the
    // escapes for the parentheses collapse into capture groups — so it was
    // matching a different expression than the one written down, and failed
    // against source that was already correct.
    assert.ok(
      body(EMPLOYEES, name).includes(
        `withServingTenant(organizationId, () => ${name}Scoped(organizationId))`
      ),
      `${name} must widen at the read`
    );
  }
});

test("the raw SQL moved behind the widening rather than beside it", () => {
  // The failure this guards against is a widened wrapper added while the
  // unwidened original stays exported under its old name — every existing
  // caller keeps the broken read and every test still passes.
  for (const name of ["listEmployees", "hasActiveEmployees"]) {
    assert.ok(
      !/getPool\(\)\.query/.test(body(EMPLOYEES, name)),
      `${name} must not query directly — that body belongs in ${name}Scoped`
    );
    assert.match(body(EMPLOYEES, `${name}Scoped`), /getPool\(\)\.query/);
    // Scoped is the private half. Exporting it puts the unwidened read back
    // within reach of exactly the call sites this exists to protect.
    assert.ok(
      !EMPLOYEES.includes(`export async function ${name}Scoped`),
      `${name}Scoped must not be exported`
    );
  }
});

test("the gate probes the reader that was missed, not only the one that was fixed", () => {
  // `hasStaffOnShift` and `hasActiveEmployees` answer the same question — "can
  // anyone here take this" — and only one of them was widened for two days.
  // The gate probed the fixed one, which is why it passed the whole time.
  const GATE = read("apps", "api", "src", "scripts", "shared-number-check.ts");
  assert.match(GATE, /name: "handoff release"/);
  assert.match(GATE, /hasActiveEmployees\(serving\.id\)/);
  assert.match(GATE, /name: "staff on shift"/);
  assert.match(GATE, /hasStaffOnShift\(serving\.id\)/);
});
