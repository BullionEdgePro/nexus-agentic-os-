// Every per-business number counted routed traffic under the number's owner.
//
// Measured on production 2026-08-19, before the fix:
//
//   conversation_metrics   2 rows attributed to zipicka belonged to ABR and SFS
//   messages              10 rows attributed to zipicka belonged to Juris Prime (6),
//                            SFS (3) and ABR (1)
//
// The rows were not wrong. They MUST carry the owner's organization_id: the
// reply path writes them inside the number owner's transaction, and the serving
// business's id would fail the RLS `with check`. What was wrong is that every
// per-business READ keyed on that column -- and under RLS the serving business
// could not see the rows at all, so changing a WHERE clause alone would have
// fixed nothing. Both halves had to move: the policy, then the reads.
//
// The inbox was the most visible instance. `where c.organization_id = $1`
// showed Juris Prime an empty inbox while its own customers were waiting, and
// showed Zipicka three conversations it could not help with.
//
// Verified against production after migration 054:
//
//   as juris-prime, messages visible                        6   (was 0)
//   of those, owned by zipicka and served by juris-prime    6
//   zipicka's OWN messages visible to juris-prime           0   <- isolation intact
//   as zipicka, messages visible                           66
//   of those, served by somebody else                      10   <- excluded by the reads
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const MIGRATION = read(
  "packages", "db", "migrations",
  "054-routed-traffic-belongs-to-the-serving-business.sql"
);
const CONTACTS_MIGRATION = read(
  "packages", "db", "migrations",
  "055-a-contact-is-visible-to-whoever-serves-them.sql"
);
const CAST_FIX = read(
  "packages", "db", "migrations",
  "056-an-unset-tenant-must-not-throw-inside-a-policy.sql"
);

test("the column is maintained by a trigger, not by every writer", () => {
  // Every writer remembering is the pattern this codebase has been bitten by
  // seven times; it holds until somebody adds the eighth call site. A trigger
  // makes it a property of the row instead of a rule about the code.
  assert.match(MIGRATION, /before insert or update of conversation_id on messages/);
  assert.match(MIGRATION, /before insert or update of conversation_id on conversation_metrics/);
  assert.match(MIGRATION, /set_serving_organization_from_conversation/);
});

test("routing a conversation after the fact carries its history with it", () => {
  // The case no writer could have covered. A customer says "hi", gets the
  // triage menu, and picks a business -- so the opening exchange of every
  // routed conversation is written BEFORE anyone knows who is serving it.
  // Without the cascade those rows stay filed under the owner forever.
  assert.match(MIGRATION, /after update of routed_organization_id on conversations/);
  assert.match(MIGRATION, /cascade_serving_organization/);
  assert.match(MIGRATION, /old\.routed_organization_id is distinct from new\.routed_organization_id/);
});

test("the serving business may read, and still may not write", () => {
  // A serving business reads the conversation it is answering. It does not
  // create one or re-route it -- that is the switchboard's job, and the
  // switchboard runs as the owner. The `using` clause widens; `with check`
  // deliberately does not.
  const policy = MIGRATION.slice(
    MIGRATION.indexOf("create policy conversations_tenant_isolation"),
    MIGRATION.indexOf("do $$", MIGRATION.indexOf("create policy conversations_tenant_isolation"))
  );
  const using = policy.slice(policy.indexOf("using ("), policy.indexOf("with check ("));
  const check = policy.slice(policy.indexOf("with check ("));
  assert.ok(using.includes("routed_organization_id"), "reads must reach the serving business");
  assert.ok(!check.includes("routed_organization_id"), "writes must stay with the owner");
});

test("no policy reads a table that is itself under a policy", () => {
  // The alternative to a denormalised column was a subquery against
  // conversations inside the messages policy. It runs per row on the hottest
  // table on the platform, and conversations is itself under RLS -- a policy
  // whose truth depends on another policy is not something anybody can reason
  // about at three in the morning.
  const policies = MIGRATION.slice(MIGRATION.indexOf("-- 4. The policies"));
  assert.ok(!/select\s+1\s+from\s+conversations/.test(policies), "no subquery in a policy");
});

test("the backfill is a recomputation and says so", () => {
  // Unlike operator_findings in 053, this records an objective fact fully
  // derivable from a row that already exists. Leaving it null would leave every
  // historical number wrong for no reason.
  assert.match(MIGRATION, /update messages m/);
  assert.match(MIGRATION, /update conversation_metrics cm/);
  // And it refuses to finish if anything was missed, rather than reporting a
  // partial backfill as done.
  assert.match(MIGRATION, /have no serving business after the backfill/);
});

test("every per-business read of the two tables resolves through the serving business", () => {
  const sites = [
    ["packages/db/src/quality.ts", "where m.serving_organization_id = $1"],
    ["packages/db/src/quality.ts", "where cm.serving_organization_id = $1"],
    ["packages/db/src/quality.ts", "where serving_organization_id = $1"],
    ["apps/api/src/services/procedure-inference.ts", "where m.serving_organization_id = $1"],
    ["apps/api/src/services/procedure-inference.ts", "where serving_organization_id = $1"],
  ];
  for (const [file, needle] of sites) {
    assert.ok(read(...file.split("/")).includes(needle), `${file} is missing: ${needle}`);
  }
});

test("the inbox shows a business its own conversations", () => {
  const CONVERSATIONS = read("packages", "db", "src", "conversations.ts");
  assert.ok(
    CONVERSATIONS.includes("where coalesce(c.routed_organization_id, c.organization_id) = $1"),
    "the inbox must resolve the serving business"
  );
  assert.ok(
    !CONVERSATIONS.includes("where c.organization_id = $1"),
    "filtering the inbox by the number's owner is the defect"
  );
});

test("agent_quality_daily is deliberately NOT re-resolved", () => {
  // Its rows are already per business -- the rollup that writes them is what
  // was wrong, and it is fixed above. Resolving again on the way out would
  // double-apply the correction, which is the kind of fix that looks like one
  // and quietly halves somebody's numbers.
  const QUALITY = read("packages", "db", "src", "quality.ts");
  const trend = QUALITY.slice(QUALITY.indexOf("export async function getQualityTrend"));
  const body = trend.slice(0, trend.indexOf("\nexport "));
  assert.ok(body.includes("agent_quality_daily"), "getQualityTrend reads the rollup");
  assert.ok(
    !body.includes("serving_organization_id"),
    "the rollup is already per business; resolving twice would be wrong"
  );
});

test("the contact is visible to whoever is serving them", () => {
  // 054 was not enough and the inbox proved it. Measured as ABR immediately
  // after 054:
  //
  //   conversations abr can see                 1
  //   contacts abr can see                      0
  //   conversations surviving the contact join  0
  //
  // The inbox joins contacts for the customer's name, and a contact belongs to
  // the number's owner because it is created when the message arrives, before
  // anybody knows which business is being asked for. The inner join silently
  // removed the row 054 had just made visible.
  //
  // A LEFT JOIN would have hidden this rather than fixed it: an inbox entry
  // with no name and no number is not something anybody can act on.
  assert.match(CONTACTS_MIGRATION, /served_organization_ids uuid\[\] not null default/);
  assert.match(CONTACTS_MIGRATION, /any \(served_organization_ids\)/);
});

test("a contact can be served by more than one business at once", () => {
  // An array, not a second serving_organization_id. A conversation has one
  // serving business; a CONTACT can have several -- the same person may ask the
  // letting agent about a flat and the law firm about a lease, on the same
  // number, and both need their name. A single column would pick one and be
  // wrong for the other.
  assert.match(CONTACTS_MIGRATION, /array_agg\(distinct coalesce\(c\.routed_organization_id, c\.organization_id\)\)/);
  // Rebuilt from the conversations rather than appended to, so a conversation
  // that is deleted or re-routed away stops granting access.
  assert.match(CONTACTS_MIGRATION, /after insert or delete or update of routed_organization_id, contact_id on conversations/);
});

test("the contacts policy still tests a column, not another policy", () => {
  // Same rule as 054. "Exists a conversation for this contact routed to me"
  // would have worked and would have made the contacts policy depend on the
  // conversations policy.
  // BOUNDED TO THE POLICY STATEMENT. The first version sliced to the end of
  // the file and matched the assertion block below it, which legitimately
  // does select from conversations -- a test that could not tell a policy
  // from the check that verifies it.
  const policyStart = CONTACTS_MIGRATION.indexOf("create policy contacts_tenant_isolation");
  const policy = CONTACTS_MIGRATION.slice(
    policyStart,
    CONTACTS_MIGRATION.indexOf("-- ---", policyStart)
  );
  assert.ok(!/select\s+1\s+from\s+conversations/.test(policy), "no subquery in the policy");
  const check = policy.slice(policy.indexOf("with check ("));
  assert.ok(!check.includes("served_organization_ids"), "writes must stay with the owner");
});

test("no policy casts the tenant setting to uuid", () => {
  // 055 wrote `current_setting('app.current_org', true)::uuid = any (...)`.
  // `withAllTenants` sets only app.tenant_scope and never app.current_org --
  // a cross-tenant unit of work has no current organisation -- so inside it
  // that setting is '' and the cast raises "invalid input syntax for type
  // uuid". Worse, whether the cast was REACHED depended on how the planner
  // ordered the OR branches: the same policy threw for one cross-tenant query
  // and returned rows for another.
  //
  // Every older policy avoids this by casting the COLUMN to text instead. An
  // array cannot be compared that way, so this uses nullif: an unset tenant
  // becomes NULL, NULL = any(...) is NULL, and a NULL branch of an OR is simply
  // not true.
  assert.match(CAST_FIX, /nullif\(current_setting\('app\.current_org', true\), ''\)::uuid = any \(served_organization_ids\)/);
  const policy = CAST_FIX.slice(CAST_FIX.indexOf("create policy contacts_tenant_isolation"));
  assert.ok(
    !/[^f]current_setting\('app\.current_org', true\)::uuid/.test(policy),
    "an unguarded cast of the tenant setting is the defect"
  );
});

test("the migration does not pretend to verify its own policy", () => {
  // Migrations run as the OWNER, who bypasses row-level security
  // unconditionally -- so a probe inside one never evaluates the policy at all
  // and reports the same thing whether it is correct, broken, or absent. The
  // first version of 056 ended with exactly such a block, and it cheerfully
  // announced that ABR could see fifteen contacts, which is the number ABR must
  // not see.
  assert.ok(!/^do \$\$/m.test(CAST_FIX), "no self-probe in a file that cannot run one");
  assert.match(CAST_FIX, /WHY THERE IS NO PROBE HERE/);
});

test("header search finds a customer for the firm serving them", () => {
  // The fix for the inbox reached the inbox and not this. Keyed on
  // ct.organization_id, an employee of Juris Prime searching for their own
  // customer by name got nothing at all -- the same emptiness, one screen over.
  //
  // Measured on production before and after:
  //
  //   old rule, keyed on who owns the contact row   0 hits for juris-prime
  //   new rule, keyed on who is serving them        1 hit
  const SEARCH = read("packages", "db", "src", "search.ts");
  assert.match(SEARCH, /\$2::uuid = any \(ct\.served_organization_ids\)/);
  assert.ok(
    !/where \(\$2::uuid is null or ct\.organization_id = \$2\)/.test(SEARCH),
    "searching by who owns the contact row is the defect"
  );
  // A contact imported before they ever messaged has an empty array and still
  // belongs to whoever created them.
  assert.match(SEARCH, /cardinality\(ct\.served_organization_ids\) = 0/);
});

test("a search result is labelled by the conversation, not the contact", () => {
  // A contact belongs to the number's owner, so the label read "Zipicka" beside
  // every routed customer -- including on an operator's global search, where
  // the label is the only thing separating five businesses' customers.
  //
  // From the CONVERSATION rather than the contact's served set, because a
  // person who asks the letting agent about a flat and the law firm about a
  // lease belongs to both and a single label has to pick one. Production check:
  // the contact whose WhatsApp profile name is "Zipicka Trading Dxb" now
  // labels as juris-prime, which is who they are actually talking to.
  const SEARCH = read("packages", "db", "src", "search.ts");
  assert.match(SEARCH, /coalesce\(routed_organization_id, organization_id\) as serving/);
  assert.match(SEARCH, /join organizations o on o\.id = coalesce\(c\.serving, ct\.organization_id\)/);
  assert.ok(
    !/join organizations o on o\.id = ct\.organization_id/.test(SEARCH),
    "labelling by the contact's owner is the defect"
  );
});
