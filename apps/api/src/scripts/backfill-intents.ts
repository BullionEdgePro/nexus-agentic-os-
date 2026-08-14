/**
 * Classifies the conversations that were handled before there was a classifier.
 *
 * Until now `conversation_metrics.intent` was derived from tool calls alone, so
 * every conversation that fired no tool — 83% of production traffic — was
 * recorded with a NULL intent and was invisible to F5. Those rows are still
 * there, and the messages that produced them are still in `messages`, so the
 * history can be read rather than written off.
 *
 * WHAT THIS CAN AND CANNOT RECOVER, and why the gap costs nothing:
 *
 * Tool calls are not stored on the metric row, so a backfill can only replay
 * the TEXT half of `classifyIntent`. That turns out to be exactly the right
 * half: a conversation that fired a tool already had its intent set at the
 * time, so it is not NULL and this script does not touch it. Every row this
 * script can see is, by construction, a row no tool ever spoke for. The
 * backfill is therefore complete over the rows it claims, rather than a
 * best-effort approximation of them.
 *
 * PAIRING A METRIC ROW TO ITS MESSAGE. `conversation_metrics` carries no
 * message_id — only conversation_id and recorded_at — so the message is
 * recovered as the latest INBOUND message in that conversation at or before
 * recorded_at. That is the message the row was written for: metrics are
 * recorded synchronously while handling one inbound message. A row whose
 * message cannot be found is reported and skipped, never guessed at.
 *
 * DRY RUN BY DEFAULT. Prints what it would write and changes nothing. Pass
 * --apply to write. Only ever fills rows where intent IS NULL, so it cannot
 * overwrite a classification made at the time, and re-running it is a no-op.
 *
 * Run:
 *   docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/backfill-intents.ts
 *   docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/backfill-intents.ts --apply
 */

import { getPool, withAllTenants, getIntentCoverage } from "@nexus/db";
import { classifyIntent } from "@nexus/agents";

const APPLY = process.argv.includes("--apply");

interface UnclassifiedRow {
  id: string;
  slug: string;
  body: string | null;
}

async function main(): Promise<void> {
  // Cross-tenant by nature: this repairs a platform-wide analytics gap, and the
  // whole point is that it spans every business. Stated rather than implied so
  // it appears when someone greps for queries that cross the boundary — and
  // required in any case, since conversation_metrics is tenant-scoped and the
  // UPDATE below must satisfy the RLS policies on it.
  await withAllTenants("backfill-intents: repairs a platform-wide analytics gap", async () => {
    const before = await getIntentCoverage();

    const { rows } = await getPool().query<UnclassifiedRow>(
      `select cm.id,
              o.slug,
              (
                select m.body
                  from messages m
                 where m.conversation_id = cm.conversation_id
                   and m.direction = 'inbound'
                   and m.created_at <= cm.recorded_at
                 order by m.created_at desc
                 limit 1
              ) as body
         from conversation_metrics cm
         join organizations o on o.id = cm.organization_id
        where cm.intent is null
        order by cm.recorded_at`
    );

    if (rows.length === 0) {
      console.log("Nothing to backfill — no metric row has a NULL intent.");
      report(before, before);
      return;
    }

    const counts = new Map<string, number>();
    const updates: Array<{ id: string; intent: string }> = [];
    let unpaired = 0;

    for (const row of rows) {
      if (!row.body) {
        // No inbound message found at or before this row. Reported rather than
        // filed as `unknown`: "we could not find the message" and "we read the
        // message and could not place it" are different facts, and collapsing
        // them would put a classification on a row nothing was ever read for.
        unpaired++;
        continue;
      }
      const { intent } = classifyIntent({ text: row.body });
      counts.set(intent, (counts.get(intent) ?? 0) + 1);
      updates.push({ id: row.id, intent });
    }

    console.log(`${rows.length} metric rows carry a NULL intent.`);
    if (unpaired > 0) {
      console.log(`  ${unpaired} could not be paired with an inbound message — skipped, not guessed.`);
    }
    for (const [intent, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${intent}`);
    }

    if (!APPLY) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to write these.");
      return;
    }

    for (const update of updates) {
      await getPool().query(
        // The NULL guard is repeated here and not just in the SELECT above: the
        // two statements are not one transaction, and a row classified live
        // between them must win over this backfill's reading of history.
        `update conversation_metrics set intent = $2 where id = $1 and intent is null`,
        [update.id, update.intent]
      );
    }

    console.log(`\nWrote ${updates.length} intents.`);
    report(before, await getIntentCoverage());
  });
}

/**
 * Coverage before and after, because the number this script exists to move is
 * the one worth printing. A count of rows written says the script ran; the
 * coverage rate says whether it helped.
 */
function report(
  before: Awaited<ReturnType<typeof getIntentCoverage>>,
  after: Awaited<ReturnType<typeof getIntentCoverage>>
): void {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  console.log(
    `\nIntent coverage: ${pct(before.rate)} -> ${pct(after.rate)} ` +
      `(${after.classified}/${after.conversations} conversations poolable, ` +
      `${after.nonPatternOnly} unknown-or-pitch, ${after.neverClassified} never classified)`
  );
  if (after.neverClassified > 0) {
    console.log(
      "NOTE: rows still carrying a NULL intent mean the classifier did not run for them. " +
        "Nothing in the reply path writes NULL any more, so any that remain are either " +
        "unpairable history or a defect worth chasing."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
