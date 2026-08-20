// The contacts write policy stays owner-only, and that is not an oversight.
//
// Migration 058 widened the MESSAGES write check so a firm can answer the
// customer it is serving. Applying the same reasoning to CONTACTS looks like
// the obvious next step and would be wrong, so this records why before somebody
// closes the "inconsistency".
//
// A message belongs to exactly one conversation, so it has exactly one serving
// business. Widening was safe: the row is that firm's to write.
//
// A CONTACT IS SHARED. One row per person per number, and migration 055's
// `served_organization_ids` is an array precisely because the same person may
// ask the letting agent about a flat and the law firm about a lease. Every
// mutable field on that row is a single value:
//
//   ai_paused_until          pausing the AI because Juris Prime's lawyer took
//                            over would silence SFS's agent for the same person
//   display_name             one firm correcting a name changes it for all
//   reengagement_opted_out   opting out of one firm's campaigns opts out of all
//
// So widening the check would not grant "write your own customer" — it would
// grant "write a row another firm depends on". The right fix, when it matters,
// is per-business contact state, not a wider policy. There is nothing to build
// that against yet: measured on production, all 16 contacts are served by
// exactly one business and no AI pause is live.
//
// The write path is not currently blocked, for a reason that is itself worth
// knowing: every route that writes a served contact — the direct-contact
// handover included — is mounted without a `:slug`, so tenantContext hands it a
// cross-tenant context and the policy never applies. That is the same accident
// of URL shape that migration 058 removed for messages, still standing here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const M055 = read("packages", "db", "migrations", "055-a-contact-is-visible-to-whoever-serves-them.sql");
const M056 = read("packages", "db", "migrations", "056-an-unset-tenant-must-not-throw-inside-a-policy.sql");

/** The most recent definition of the contacts policy, which is 056's. */
function contactsPolicy(sql) {
  const start = sql.indexOf("create policy contacts_tenant_isolation");
  assert.ok(start > -1, "the contacts policy moved");
  return sql.slice(start, sql.indexOf(";", sql.indexOf("with check", start)));
}

test("a serving firm may READ a contact it is talking to", () => {
  // This half is settled and must not regress: without it, the serving firm's
  // inbox and search were both empty for their own customer.
  const p = contactsPolicy(M056);
  const using = p.slice(p.indexOf("using ("), p.indexOf("with check ("));
  assert.match(using, /served_organization_ids/);
});

test("and may NOT write it, because the row is shared", () => {
  const p = contactsPolicy(M056);
  const check = p.slice(p.indexOf("with check ("));
  assert.ok(
    !check.includes("served_organization_ids"),
    "widening this grants one firm write access to a row another firm depends on"
  );
  assert.match(check, /organization_id::text = current_setting\('app\.current_org', true\)/);
});

test("the array exists because a contact can be served by several firms", () => {
  // The justification for not widening rests entirely on this being a SET
  // rather than a single owner. If it ever collapses to one column, the
  // reasoning above collapses with it and should be revisited.
  assert.match(M055, /served_organization_ids uuid\[\]/);
  assert.match(M055, /array_agg\(distinct coalesce\(c\.routed_organization_id, c\.organization_id\)\)/);
});

test("the fields that would collide are still single-valued", () => {
  // If any of these becomes per-business, that is the moment to revisit the
  // write policy — the objection is about shared mutable state, not about
  // serving firms being untrustworthy.
  const SCHEMA = read("packages", "db", "schema.sql");
  const contacts = SCHEMA.slice(
    SCHEMA.indexOf("create table contacts"),
    SCHEMA.indexOf(");", SCHEMA.indexOf("create table contacts"))
  );
  for (const column of ["ai_paused_until", "display_name"]) {
    assert.ok(contacts.includes(column), `${column} left the contacts row — revisit 058's reasoning`);
  }
});
