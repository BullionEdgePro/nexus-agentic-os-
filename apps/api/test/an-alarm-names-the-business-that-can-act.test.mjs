// An alarm is only useful to the business that can act on it.
//
// All five firms answer on one WhatsApp number, so a routed conversation's rows
// carry the NUMBER OWNER's organization_id. Every operator keyed on that column
// therefore fires at Zipicka about another firm's traffic, and stays silent on
// the page belonging to the firm that could fix it.
//
// This was measured on 2026-08-19 from findings already in the table: two
// customer-waiting alerts filed against Zipicka for customers of SFS
// International and Juris Prime, the second of them the seventeen-hour silence.
// Those two operators were fixed then. Five more were still keyed on the owner,
// and this is the rest of the sweep.
//
// The last one needed a different shape. `reengagement-candidate` counts
// CONTACTS, and a contact is created by the number's owner before anybody knows
// which firm is being asked for -- so there is no single owning business to
// resolve to. Migration 055's array answers it: the same person may ask the
// letting agent about a flat and the law firm about a lease, and both should be
// able to follow up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OPERATORS = readFileSync(
  join(here, "..", "..", "..", "apps", "api", "src", "services", "operators.ts"),
  "utf8"
);

/** One operator's definition, so an assertion cannot match its neighbour. */
function operator(slug) {
  const marker = `slug: "${slug}"`;
  const start = OPERATORS.lastIndexOf("const ", OPERATORS.indexOf(marker));
  assert.ok(start > -1, `${slug} not found`);
  const next = OPERATORS.indexOf("\nconst ", start + 1);
  return next === -1 ? OPERATORS.slice(start) : OPERATORS.slice(start, next);
}

/**
 * Operators that must FILTER by the business being served.
 *
 * `customer-waiting` and `handover-abandoned` are deliberately not here, and
 * the distinction is the whole design of migration 053. They raise one finding
 * per CONVERSATION, and findings are reconciled — raised, touched, and
 * RETRACTED when they no longer hold — keyed on (organization_id, operator).
 * If they filtered on the serving business, the finding would be raised during
 * that firm's turn in the sweep... and Juris Prime's turn cannot see a routed
 * conversation it does not own, so the next sweep would retract what the last
 * one raised, forever.
 *
 * So those two keep filtering on the owner, and carry the serving business on
 * the finding instead. The first version of this test applied one blanket rule
 * to all six and reported both as defects — it would have had me "fix" the
 * mechanism into a retraction loop.
 */
const MUST_FILTER_BY_SERVING = [
  "retrieval-unavailable",
  "intent-unclassified",
  "agent-unavailable",
  "delivery-failing",
];

/** SQL with its comments removed, so an assertion cannot match prose. */
function sqlOf(body) {
  return (body.match(/`([^`]*)`/g) ?? [])
    .join(" ")
    .replace(/--[^\n]*/g, " ");
}

test("no aggregate alarm keys a per-business question on the number's owner", () => {
  const offenders = MUST_FILTER_BY_SERVING.filter((slug) =>
    /\bwhere\s+(\w+\.)?organization_id = \$1/.test(sqlOf(operator(slug)))
  );
  assert.deepEqual(
    offenders,
    [],
    `these alarms fire at the number's owner rather than the firm that can act: ${offenders.join(", ")}`
  );
});

test("the two per-conversation operators keep filtering by the owner, on purpose", () => {
  // Asserted as a POSITIVE, because it looks like the bug and is not. Losing
  // this would not fail loudly — it would make every routed finding flicker in
  // and out on alternate sweeps.
  for (const slug of ["customer-waiting", "handover-abandoned"]) {
    const sql = sqlOf(operator(slug));
    assert.match(sql, /where c\.organization_id = \$1/,
      `${slug} must stay owned by the transaction that can see the conversation`);
    assert.match(sql, /coalesce\(c\.routed_organization_id, c\.organization_id\)/,
      `${slug} must still name the serving business on the finding`);
  }
});

test("the four metric and message operators resolve the serving business", () => {
  for (const slug of [
    "retrieval-unavailable",
    "intent-unclassified",
    "agent-unavailable",
    "delivery-failing",
  ]) {
    assert.match(
      operator(slug),
      /where serving_organization_id = \$1/,
      `${slug} must alarm at the business being served`
    );
  }
});

test("reengagement resolves through a SET, because a contact can have several", () => {
  const body = operator("reengagement-candidate");
  assert.match(body, /\$1::uuid = any \(ct\.served_organization_ids\)/);
  // A contact with no conversations yet has an empty array and still belongs to
  // whoever created it — dropping that fallback would empty the list for every
  // business that imported contacts before they ever messaged.
  assert.match(body, /cardinality\(ct\.served_organization_ids\) = 0/);
  assert.match(body, /ct\.organization_id = \$1/);
});

test("nothing here reads a column the schema does not have", () => {
  // This operator has form: its first version read conversations.updated_at,
  // which does not exist, and threw for all five businesses on the first sweep.
  // The columns these queries now depend on arrived in migrations 054 and 055.
  // COMMENTS STRIPPED FIRST. The first version searched the raw SQL and matched
  // the comment that EXPLAINS the updated_at bug — a test that cannot tell a
  // query from the sentence describing one.
  const sql = sqlOf(OPERATORS);
  for (const column of ["serving_organization_id", "served_organization_ids", "routed_organization_id"]) {
    assert.ok(sql.includes(column), `${column} is no longer used — was a fix reverted?`);
  }
  assert.ok(!/conversations?\.updated_at/.test(sql), "conversations has no updated_at");
});
