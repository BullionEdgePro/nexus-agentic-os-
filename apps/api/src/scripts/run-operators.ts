/**
 * Run one operator sweep now, and say what it found.
 *
 *   docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/run-operators.ts
 *
 * WHY THIS EXISTS. The sweep is scheduled every ten minutes, and BullMQ's
 * repeating jobs fire at the next interval rather than immediately — so for the
 * first ten minutes after a deploy there is no evidence at all that the
 * operators work. Worse, their normal healthy output is an empty findings
 * table, which is indistinguishable from "the queries are broken and every one
 * threw". That is the ambiguity the whole feature is built to avoid, and it
 * applied to the feature itself.
 *
 * So this runs the real sweep against real data and prints the result per
 * operator, including operators that found nothing — the distinction that
 * matters. It changes state exactly as the scheduled run does, which is the
 * point: it is the same code path, not a simulation of it.
 */
import { getPool } from "@nexus/db";
import { runOperators, OPERATORS } from "../services/operators.js";

async function main(): Promise<number> {
  console.log("Operator sweep — running every operator against every business\n");

  const started = Date.now();
  const summaries = await runOperators();
  const elapsed = Date.now() - started;

  let failed = 0;

  for (const operator of OPERATORS) {
    const mine = summaries.filter((s) => s.operator === operator.slug);
    const broke = mine.filter((s) => s.failed);
    const standing = mine.reduce((n, s) => n + s.standing, 0);
    const retracted = mine.reduce((n, s) => n + s.retracted, 0);

    if (broke.length > 0) {
      failed += broke.length;
      console.log(`  FAIL  ${operator.slug.padEnd(20)} ${broke[0].failed?.slice(0, 90)}`);
      for (const b of broke) console.log(`        └ ${b.organizationSlug}`);
      continue;
    }

    // "ran, found nothing" is printed as loudly as "found three". Silence for
    // the healthy case is what makes a broken sweep invisible.
    console.log(
      `  ok    ${operator.slug.padEnd(20)} ` +
        `${standing} standing, ${retracted} retracted, across ${mine.length} businesses`
    );
  }

  console.log(
    failed === 0
      ? `\nPASS — every operator ran against every business in ${elapsed}ms.\n`
      : `\nFAIL — ${failed} operator/business pair(s) threw. Their existing findings were left untouched.\n`
  );

  await getPool().end();
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
