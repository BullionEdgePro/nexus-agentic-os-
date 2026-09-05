// A TypeScript union and a SQL check constraint are the same list, twice.
//
// This codebase has been bitten repeatedly by one list typed in two places —
// TENANT_SCOPED_TABLES existed in three copies and a table was protected only
// if it appeared in all of them; migration 018's array and rls-verify's copy
// disagreed for weeks. Those were unified. Union-versus-constraint is the same
// shape and cannot be unified, because one half has to exist in the database.
//
// So it is checked instead. Every pair below is a union in packages/shared and
// the constraint that enforces it, and they must list exactly the same values.
// Adding a value to one and not the other is a write that typechecks and then
// fails at runtime, or a value the database accepts that no code models.
//
// Measured when this was written: every existing pair AGREED. What the sweep
// actually found was three unions with no constraint at all —
// messages.direction, .sender_type and .status — which migration 060 added.
// Those three decide whether a customer is counted as waiting, whether a reply
// counts as outbound, and where a message sits on the delivery ladder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

/**
 * union in packages/shared  →  the constraint that enforces it.
 *
 * An explicit map rather than inference. Guessing which constraint models which
 * union is exactly the kind of cleverness that quietly stops covering something
 * when a name changes.
 */
const PAIRS = [
  { union: "ReplyOutcome", constraint: "reply_outcome" },
  { union: "RetrievalOutcome", constraint: "retrieval_outcome" },
  { union: "ResolvedBy", constraint: "resolved_by" },
  { union: "MessageDirection", constraint: "direction" },
  { union: "SenderType", constraint: "sender_type" },
  { union: "MessageStatus", constraint: "status", table: "messages" },
  { union: "ScheduledMessageStatus", constraint: "status", table: "scheduled_messages" },
];

const SHARED = (() => {
  const dir = join(root, "packages", "shared", "src");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
})();

/**
 * schema.sql FIRST, then every migration in order.
 *
 * The baseline defines constraints too -- resolved_by is declared inline on the
 * conversation_metrics table and never touched since. Reading only migrations
 * reported it as unconstrained, which is a test finding a gap in itself and
 * calling it a gap in the code.
 */
const MIGRATIONS = (() => {
  const dir = join(root, "packages", "db", "migrations");
  const baseline = {
    file: "schema.sql",
    sql: readFileSync(join(root, "packages", "db", "schema.sql"), "utf8"),
  };
  return [
    baseline,
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: f, sql: readFileSync(join(dir, f), "utf8") })),
  ];
})();

function unionValues(name) {
  const m = SHARED.match(new RegExp(`export type ${name}\\s*=([^;]+);`));
  assert.ok(m, `union ${name} not found in packages/shared`);
  return [...new Set([...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]))].sort();
}

/**
 * The values a column's check constraint allows, from the LAST place that
 * defines it.
 *
 * Last, because constraints get widened: reply_outcome gained
 * `skipped_handover` in 057, so the first definition found is the historical
 * one rather than the one in force.
 *
 * Written as "find the check clause, then read the quoted values out of it".
 * The first version built one regex mentioning the column twice, and
 * `${column}?` made the final LETTER optional rather than the whole word — so
 * it silently required the name to appear twice and reported schema.sql's
 * `resolved_by text check (resolved_by in (...))` as unconstrained. A test
 * finding a gap in itself and calling it a gap in the code.
 */
function constraintValues(column, table) {
  let found = null;
  for (const { file, sql } of MIGRATIONS) {
    // Match where the TABLE is declared or altered — `table <name>` — not any
    // mention of the word. A bare `sql.includes("messages")` also matched
    // `scheduled_messages` (and even a comment reading "Scheduled messages"),
    // so a second table's status check was read as the first's. Anchoring on
    // `table <name>` keeps each constraint tied to its own table.
    if (table && !new RegExp(`table\\s+${table}\\b`, "i").test(sql)) continue;
    // Every `check ( ... )` clause, balanced enough for these: the bodies here
    // are flat lists with no nested parentheses beyond the array literal.
    for (const m of sql.matchAll(/check\s*\(([\s\S]*?)\)\s*(?:,|;|\n\s*\))/gi)) {
      const clause = m[1];
      if (!new RegExp(`\\b${column}\\b`).test(clause)) continue;
      const vals = [...new Set([...clause.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]))];
      if (vals.length > 0) found = { file, values: vals.sort() };
    }
  }
  return found;
}

test("every union and the constraint enforcing it list the same values", () => {
  const mismatches = [];
  for (const pair of PAIRS) {
    const ts = unionValues(pair.union);
    const sql = constraintValues(pair.constraint, pair.table);
    if (!sql) {
      mismatches.push(`${pair.union}: no constraint found for "${pair.constraint}"`);
      continue;
    }
    if (ts.join(",") !== sql.values.join(",")) {
      mismatches.push(
        `${pair.union} (${ts.join(", ")})  vs  ${sql.file} (${sql.values.join(", ")})`
      );
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    "a union and the constraint enforcing it have drifted — one of these is a " +
      `write that typechecks and fails at runtime:\n  ${mismatches.join("\n  ")}`
  );
});

test("the three columns the reply path branches on are constrained at all", () => {
  // The point of the sweep. These decide whether a customer counts as waiting,
  // whether a reply counts as outbound, and where a message sits on the
  // delivery ladder — and the database used to accept any string in them, so a
  // row written with "Contact" would satisfy no query and break none.
  const m060 = MIGRATIONS.find((x) => x.file.startsWith("060-"));
  assert.ok(m060, "migration 060 is missing");
  for (const c of ["messages_direction_check", "messages_sender_type_check", "messages_status_check"]) {
    assert.ok(m060.sql.includes(c), `${c} is not created`);
  }
  // Nullable on purpose: an inbound message has no delivery state of ours.
  assert.match(m060.sql, /status is null or status = any/);
});

test("the checker can actually fail", () => {
  // A check that cannot fail is worse than none. Ask it about a union whose
  // constraint deliberately does not match.
  const ts = unionValues("ReplyOutcome");
  const sql = constraintValues("reply_outcome");
  assert.ok(sql, "reply_outcome constraint not found");
  const tampered = sql.values.filter((v) => v !== "skipped_handover");
  assert.notEqual(
    ts.join(","),
    tampered.join(","),
    "removing a value from one side must produce a difference"
  );
});
