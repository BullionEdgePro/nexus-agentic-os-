import { findStaleSources, markSourceFailed, ingestUrlSet } from "@nexus/knowledge";
import { logger } from "../lib/logger.js";
import { withJobHeartbeat, withAllTenants, withTenant } from "@nexus/db";
import { KNOWLEDGE_SOURCES_PER_RUN, KNOWLEDGE_STALE_AFTER_HOURS } from "@nexus/shared";

/**
 * Bounded per cycle — see findStaleSources for why quota makes this matter.
 *
 * Both now come from @nexus/shared, because the operator that watches whether
 * this sweep is KEEPING UP has to derive its threshold from the same two
 * numbers. A local copy here and a threshold there would agree until the day
 * somebody tuned one of them.
 */
const SOURCES_PER_RUN = KNOWLEDGE_SOURCES_PER_RUN;
const STALE_AFTER_HOURS = KNOWLEDGE_STALE_AFTER_HOURS;

/**
 * Refresh knowledge sources whose content may have moved on.
 *
 * Sources are grouped by (tenant, employee, host) before re-fetching because
 * cross-page boilerplate can only be detected by comparing sibling pages. A
 * page refreshed on its own would come back carrying the site chrome that was
 * stripped when it was first ingested as part of a set — so its chunks would
 * silently drift in quality with every cycle.
 *
 * Nothing here re-embeds unchanged content: ingest compares a content hash
 * first, so a cycle over unmodified pages costs one fetch each and no model
 * calls at all. That is what makes running this on a rate-limited free tier
 * viable.
 */
async function processKnowledgeReindexJobBody(): Promise<void> {
  // CROSS-TENANT ON PURPOSE, AND IT HAD TO SAY SO.
  //
  // This threw on every run since DB_TENANT_ASSERT was set to strict, and
  // nothing reported it: the scheduler logged "Knowledge re-index scheduled
  // (every 6h)" at boot and the failure happened six hours later, in a job
  // whose only trace was a log line on a box whose logs were erased on every
  // deploy. Migration 050's heartbeat found it on its first day — runs 2,
  // failures 2, last_finished_at null — and the error it recorded was the
  // assert's own sentence naming this exact fix.
  //
  // What that cost: the knowledge base has never been re-indexed on a schedule.
  // Every source's content is whatever it was when somebody last ingested it by
  // hand, and a page that changed since then is answered from the old copy —
  // silently, with a citation, which is the failure mode retrieval was built to
  // avoid. `broken-knowledge` could not have reported it either: that operator
  // watches sources marked failed, and this job threw before it could mark one.
  //
  // withAllTenants rather than a loop over businesses because the sweep's whole
  // point is to pick the twenty stalest sources ACROSS the platform — the free
  // tier's quota is the constraint, so ordering by staleness globally is what
  // makes the bound meaningful.
  const stale = await withAllTenants(
    "knowledge re-index: picks the stalest sources across every business",
    () => findStaleSources({ olderThanHours: STALE_AFTER_HOURS, limit: SOURCES_PER_RUN })
  );

  if (stale.length === 0) {
    logger.debug("Knowledge re-index: nothing stale");
    return;
  }

  const groups = new Map<string, typeof stale>();
  for (const source of stale) {
    let host: string;
    try {
      host = new URL(source.uri).host;
    } catch {
      // Scoped to the source's OWN business. `markSourceFailed` takes a source
      // id and no organization, so without this it inherits whatever context
      // happens to be open — which here is none.
      await withTenant(source.organizationId, () =>
        markSourceFailed(source.id, `Unparseable URI: ${source.uri}`)
      );
      continue;
    }
    const key = `${source.organizationId}::${source.employeeId ?? ""}::${host}`;
    const existing = groups.get(key);
    if (existing) existing.push(source);
    else groups.set(key, [source]);
  }

  let refreshed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const group of groups.values()) {
    const { organizationId, employeeId } = group[0];
    try {
      const results = await ingestUrlSet({
        organizationId,
        employeeId,
        urls: group.map((s) => s.uri),
      });

      for (const result of results) {
        if ("error" in result) {
          failed += 1;
          const source = group.find((s) => s.uri === result.url);
          if (source) {
            await withTenant(source.organizationId, () =>
              markSourceFailed(source.id, result.error)
            );
          }
          logger.warn({ url: result.url, err: result.error }, "Knowledge source refresh failed");
        } else if (result.skipped) {
          unchanged += 1;
        } else {
          refreshed += 1;
          logger.info({ url: result.url, chunks: result.chunks }, "Knowledge source re-indexed");
        }
      }
    } catch (err) {
      // A whole group failing (network outage, embedding quota) must not kill
      // the cycle — the sources stay stale and the next run retries them.
      failed += group.length;
      logger.error({ err, count: group.length }, "Knowledge re-index group failed");
    }
  }

  logger.info({ refreshed, unchanged, failed }, "Knowledge re-index cycle complete");
}

/**
 * Wrapped so this job cannot run without saying that it did (migration 050).
 *
 * The wrapper takes the body rather than sitting beside the call, because the
 * state this heartbeat exists to detect — started and never finished — is one
 * you would otherwise produce by accident the first time somebody added an
 * early return.
 */
export function processKnowledgeReindexJob(): Promise<void> {
  return withJobHeartbeat("knowledge-reindex", processKnowledgeReindexJobBody);
}
