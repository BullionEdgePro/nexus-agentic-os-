/**
 * The rule rls-verify applies to production, proved against policies that break it.
 *
 * ============================================================
 * WHY THE PROOF IS HERE AND NOT IN THE GATE
 * ============================================================
 *
 * `rls-verify` asks of every policy in production: is the WRITE side wider than
 * the READ side? On a shared number that is the difference between a business
 * seeing a conversation routed to it — which it should — and being able to write
 * rows into the number owner's tenant, which the owner can then see, did not
 * make, and cannot tell apart from its own.
 *
 * A gate is worth only what its failure case proves, and this one cannot prove
 * its own. Two reasons, and both are properties the platform is right to have:
 *
 *   The only convincing demonstration is a policy that IS too wide. Creating one
 *   on the live `conversations` table to watch a gate go red is not a test, it
 *   is an outage with a good intention. I began to do that on 2026-08-24 and
 *   was stopped by a permission check; the reflex was wrong.
 *
 *   The gate cannot build a fixture either. It connects as `nexus_app`, which
 *   owns no tables and holds no CREATE — `rls-preflight` asserts precisely that
 *   — so it has no way to make a bad policy and catch it.
 *
 * So the rule is a pure function over two strings. Here it meets the policies
 * that break it; in the gate it meets the real ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { policyFault, policyFaults, WIDENING_COLUMNS } from "@nexus/db";

/** The real shape of the three asymmetric tables, as production reports them. */
const NARROW_WRITE =
  "(((organization_id)::text = current_setting('app.current_org'::text, true)) OR " +
  "(current_setting('app.tenant_scope'::text, true) = 'all'::text))";

const WIDENED_READ =
  "(((organization_id)::text = current_setting('app.current_org'::text, true)) OR " +
  "((routed_organization_id)::text = current_setting('app.current_org'::text, true)) OR " +
  "(current_setting('app.tenant_scope'::text, true) = 'all'::text))";

const shape = (over) => ({
  table: "conversations",
  policy: "conversations_tenant_isolation",
  command: "ALL",
  qual: WIDENED_READ,
  withCheck: NARROW_WRITE,
  ...over,
});

test("the real asymmetric policy passes", () => {
  // Copied from what production actually reports, so this test fails if the
  // rule ever stops accepting the shape the platform genuinely runs.
  assert.equal(policyFault(shape()), null);
});

test("a write predicate copied from the widened read is caught", () => {
  // THE DEFECT. Somebody adds a table, copies USING into WITH CHECK because
  // that is what every other policy here does, and a serving business can now
  // write into the number owner's tenant.
  const fault = policyFault(shape({ withCheck: WIDENED_READ }));
  assert.ok(fault, "a write predicate carrying the widening column must be a fault");
  assert.match(fault.reason, /routed_organization_id/);
  assert.match(fault.reason, /only entitled to read/);
});

test("a write policy with no WITH CHECK at all is caught", () => {
  const fault = policyFault(shape({ withCheck: null }));
  assert.ok(fault, "an absent WITH CHECK constrains nothing and must be reported");
  assert.match(fault.reason, /no WITH CHECK/);
});

test("SELECT and DELETE policies are not faulted for their read width", () => {
  // Neither can introduce a row, so a wide predicate on them is the feature.
  for (const command of ["SELECT", "DELETE"]) {
    assert.equal(policyFault(shape({ command, withCheck: WIDENED_READ })), null, command);
  }
});

test("every widening column is checked, not just the first", () => {
  // WIDENING_COLUMNS has one entry today. The rule must cover a second the day
  // somebody adds one, rather than having been written around this one name.
  assert.ok(WIDENING_COLUMNS.length >= 1);
  for (const column of WIDENING_COLUMNS) {
    const fault = policyFault(shape({ withCheck: `x = y and ${column} = z` }));
    assert.ok(fault, `${column} is in WIDENING_COLUMNS and is not being checked`);
  }
});

test("faults come back sorted, and a clean set is empty", () => {
  const clean = policyFaults([shape(), shape({ table: "contacts", command: "SELECT" })]);
  assert.deepEqual(clean, []);

  const faulty = policyFaults([
    shape({ table: "zebra", withCheck: WIDENED_READ }),
    shape({ table: "alpha", withCheck: null }),
  ]);
  assert.deepEqual(
    faulty.map((f) => f.table),
    ["alpha", "zebra"],
    "faults are sorted so a gate's output does not reorder between runs"
  );
});
