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
