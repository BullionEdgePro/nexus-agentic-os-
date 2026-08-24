/**
 * Is a row-level-security policy's WRITE side wider than its READ side?
 *
 * ============================================================
 * WHY THIS IS A PURE FUNCTION AND NOT A QUERY
 * ============================================================
 *
 * `rls-verify` asks this of every policy in production. The rule it applies has
 * to be provable, and there is no safe way to prove it against production: the
 * only convincing demonstration is a policy that IS too wide, and creating one
 * on the live `conversations` table to watch a gate go red is not a test, it is
 * an outage with a good intention. I started to do exactly that on 2026-08-24
 * and was stopped; the reflex was wrong and this is the answer to it.
 *
 * Nor can the gate build its own fixture. It connects as `nexus_app`, which
 * deliberately owns no tables and holds no CREATE — that is the property
 * `rls-preflight` exists to assert — so it cannot make a bad policy to catch.
 *
 * So the rule lives here as a function over two strings, the suite proves it
 * against policies that ARE too wide, and the gate feeds it the real ones.
 *
 * ============================================================
 * WHAT "WIDER" MEANS HERE
 * ============================================================
 *
 * Postgres cannot answer implication in general, and neither can this. It
 * answers the specific question this platform has: the shared number makes three
 * tables deliberately asymmetric, where a business may READ a conversation
 * routed to it and may not WRITE it. The widening lives in one column.
 *
 * So: a write predicate must not mention a column that only the read predicate
 * is entitled to use. Today that is `routed_organization_id`. If a second
 * widening column is ever added to a read policy, it belongs in WIDENING_COLUMNS
 * and the same rule covers it.
 */

/**
 * Columns that appear in a READ predicate to widen it, and must never appear in
 * the matching WRITE predicate.
 *
 * Migration 054 added the first. A business serving a conversation on somebody
 * else's number can see it; letting it WRITE would put rows in the number
 * owner's tenant that the owner can see, did not make, and cannot tell apart
 * from its own.
 */
export const WIDENING_COLUMNS = ["routed_organization_id"] as const;

export interface PolicyShape {
  table: string;
  policy: string;
  /** The USING expression, or null for an INSERT-only policy which has none. */
  qual: string | null;
  /** The WITH CHECK expression. Null means writes are unconstrained. */
  withCheck: string | null;
  /** ALL, SELECT, INSERT, UPDATE, DELETE. */
  command: string;
}

export interface PolicyFault {
  table: string;
  policy: string;
  reason: string;
}

const WRITES = new Set(["ALL", "INSERT", "UPDATE"]);

/**
 * The fault in one policy, or null when its write side is no wider than its read.
 *
 * SELECT and DELETE policies are not examined: neither can introduce a row.
 */
export function policyFault(shape: PolicyShape): PolicyFault | null {
  if (!WRITES.has(shape.command.toUpperCase())) return null;

  if (shape.withCheck === null) {
    // Postgres falls back to USING for UPDATE when WITH CHECK is absent, but an
    // ALL or INSERT policy without one constrains nothing at all. Reported
    // rather than reasoned about: an unconstrained write is worth a person
    // looking either way.
    return {
      table: shape.table,
      policy: shape.policy,
      reason: "has no WITH CHECK, so writes are not constrained by the policy",
    };
  }

  for (const column of WIDENING_COLUMNS) {
    if (shape.withCheck.includes(column)) {
      return {
        table: shape.table,
        policy: shape.policy,
        reason:
          `its WITH CHECK mentions ${column}, which widens a READ. A business could write ` +
          `rows into another tenant that it is only entitled to read`,
      };
    }
  }

  return null;
}

/** Every fault across a set of policies, in table order. */
export function policyFaults(shapes: PolicyShape[]): PolicyFault[] {
  return shapes
    .map(policyFault)
    .filter((fault): fault is PolicyFault => fault !== null)
    .sort((a, b) => a.table.localeCompare(b.table));
}
