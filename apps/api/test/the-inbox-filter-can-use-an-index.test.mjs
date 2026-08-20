// "The inbox is fast" was a statement about having no customers.
//
// Since migration 054 the inbox filters on an EXPRESSION —
// `coalesce(c.routed_organization_id, c.organization_id) = $1` — which no
// ordinary index on either column can serve. Production holds fifteen
// conversations, and at that size Postgres ignores indexes anyway, so nothing
// about today's speed says anything about next month's.
//
// Measured in a throwaway database seeded with 2,000 conversations and 24,000
// messages, which is a modest month once the deep links are published:
//
//   inbox, serving business    0.215 ms   SEQ SCAN     <- before
//   inbox, serving business    0.062 ms   indexed      <- after 059
//
// The milliseconds are not the point at that size; the plan is. A sequential
// scan costs linearly in conversations and an index scan does not.
//
// TWO SEQ SCANS ARE LEFT AND ARE NOT DEFECTS:
//
//   customer-waiting   6.6 ms. It filters `c.organization_id = owner`, which
//                      on a shared number matches EVERY conversation — an index
//                      cannot help a predicate that selects everything. The
//                      lateral into messages is indexed. At a ten-minute
//                      cadence this has room to grow by an order of magnitude.
//
//   header search      0.6 ms. `like '%name%'` is unindexable without pg_trgm.
//                      Worth revisiting at a hundred thousand contacts, not at
//                      two thousand.
//
// Recording both here so the next person reading a Seq Scan in that output
// knows which ones were looked at and left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const MIGRATION = read("packages", "db", "migrations", "059-the-inbox-filter-can-use-an-index.sql");
const CONVERSATIONS = read("packages", "db", "src", "conversations.ts");
const PROBE = read("scripts", "load-probe.sh");

/** The exact expression, spelled once. A planner match is character-for-character. */
const EXPRESSION = "coalesce(routed_organization_id, organization_id)";

test("the index is on exactly the expression the query filters by", () => {
  assert.match(MIGRATION, /create index if not exists idx_conversations_serving/);
  assert.ok(
    MIGRATION.includes(`((${EXPRESSION}), opened_at desc)`),
    "the index must spell the coalesce the way the query does"
  );
});

test("the query still spells it that way", () => {
  // The two have to agree character for character or the planner silently
  // ignores the index and the scan comes back with nothing to announce it.
  // This is the pin: change one and this fails rather than the inbox quietly
  // getting slower as the business grows.
  assert.ok(
    CONVERSATIONS.includes(`coalesce(c.routed_organization_id, c.organization_id) = $1`),
    "the inbox filter changed shape — re-check idx_conversations_serving"
  );
});

test("the migration does not assert a plan it cannot have", () => {
  // On fifteen rows Postgres will not use this index, correctly. A migration
  // asserting the plan would fail on production while being right about the
  // code — the same trap migrations 056 and 058 had to be talked out of.
  assert.match(MIGRATION, /Deliberately NOT a probe of whether the planner uses it/);
  assert.ok(!/explain/i.test(MIGRATION), "a migration is the wrong place to measure a plan");
});

test("the load probe never touches the live database", () => {
  // It seeds two thousand conversations. Doing that anywhere near `nexus` would
  // be a far worse outcome than the slow query it exists to find.
  assert.match(PROBE, /PROBE="nexus_load_probe"/);
  assert.match(PROBE, /drop database if exists/);
  assert.match(PROBE, /trap /);
  assert.ok(
    !/-d nexus\b/.test(PROBE.replace(/-d "\$PROBE"/g, "")),
    "the probe must only ever connect to its own throwaway database"
  );
});
