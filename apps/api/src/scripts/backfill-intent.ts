/**
 * Give historical conversations the intent they were never classified with.
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/backfill-intent.ts [--apply]
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A NEW CLASSIFIER
 *
 * Text-based classification is not missing — `classifyIntent` has always fallen
 * back to `scoreLead` on the message text when no tool fired. What is missing is
 * intent on rows written BEFORE that existed. Of Zipicka's 13 conversations in
 * the last 60 days, seven carry no intent at all for exactly that reason, and
 * those seven are invisible to every feature that learns.
 *
 * That single gap starves three shipped features at once. F5's shared store
 * groups by intent. F10 needs five conversations of one kind before it will call
 * a procedure a procedure. F11 forecasts per intent. All three are built, all
 * three are correct, and all three currently have almost nothing to read.
 *
 * Backfilling is cheaper than waiting: it costs one pass over old rows rather
 * than weeks of new traffic.
 *
 * DRY BY DEFAULT. It prints what it would write and changes nothing unless
 * `--apply` is passed. A backfill is a bulk edit of the evidence every learning
 * feature reads; being able to see it first is worth the extra word.
 */
import { pathToFileURL } from "node:url";
import { getPool, withTenant, withAllTenants, listOrganizations } from "@nexus/db";
import { classifyIntent } from "@nexus/agents";

const APPLY = process.argv.includes("--apply");

interface Row {
  metric_id: string;
  conversation_id: string;
  text: string | null;
}

async function backfillOrganization(organizationId: string, slug: string) {
  return withTenant(organizationId, async () => {
    // The customer's own words, not the agent's. Intent is a property of what
    // was asked, and the earliest inbound message is what the conversation was
    // opened about — later ones drift into follow-up detail.
    const { rows } = await getPool().query<Row>(
      `select cm.id as metric_id,
              cm.conversation_id,
              (
                select m.body
                  from messages m
                 where m.conversation_id = cm.conversation_id
                   and m.sender_type = 'contact'
                   and m.body is not null
                 order by m.created_at asc
                 limit 1
              ) as text
         from conversation_metrics cm
        where cm.organization_id = $1
          and cm.intent is null`,
      [organizationId]
    );

    if (rows.length === 0) {
      console.log(`  ${slug}: nothing to backfill`);
      return { examined: 0, classified: 0, unknown: 0, noText: 0 };
    }

    let classified = 0;
    let unknown = 0;
    let noText = 0;

    for (const row of rows) {
      if (!row.text) {
        // A media-only conversation, or one whose messages were never stored.
        // Leaving it null is honest; writing 'unknown' would claim we looked at
        // words that do not exist.
        noText += 1;
        continue;
      }

      // No toolCalls on purpose. This is the text path, and pretending we know
      // which tool ran months ago would be inventing evidence.
      const { intent } = classifyIntent({ text: row.text });

      if (intent === "unknown") {
        unknown += 1;
        continue;
      }

      if (APPLY) {
        await getPool().query(`update conversation_metrics set intent = $2 where id = $1`, [
          row.metric_id,
          intent,
        ]);
      }
      classified += 1;
    }

    console.log(
      `  ${slug}: ${rows.length} without intent — ${classified} classified, ` +
        `${unknown} read but unclassifiable, ${noText} with no text`
    );
    return { examined: rows.length, classified, unknown, noText };
  });
}

async function main() {
  console.log(
    APPLY
      ? "Backfilling intent on historical conversations\n"
      : "Backfilling intent — DRY RUN, nothing will be written (pass --apply)\n"
  );

  const organizations = await withAllTenants("backfill-intent: tenant registry", () =>
    listOrganizations()
  );

  const totals = { examined: 0, classified: 0, unknown: 0, noText: 0 };
  for (const organization of organizations) {
    const result = await backfillOrganization(organization.id, organization.slug);
    totals.examined += result.examined;
    totals.classified += result.classified;
    totals.unknown += result.unknown;
    totals.noText += result.noText;
  }

  console.log(
    `\n${totals.examined} rows without intent across ${organizations.length} businesses.\n` +
      `${totals.classified} ${APPLY ? "classified" : "would be classified"}, ` +
      `${totals.unknown} unclassifiable from their text, ${totals.noText} had no text to read.`
  );

  if (!APPLY && totals.classified > 0) {
    console.log("\nNothing was written. Re-run with --apply to commit these.");
  }

  await getPool().end();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
