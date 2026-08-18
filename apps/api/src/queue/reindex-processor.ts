import { findStaleSources, markSourceFailed, ingestUrlSet } from "@nexus/knowledge";
import { logger } from "../lib/logger.js";
import { withJobHeartbeat } from "@nexus/db";

/** Bounded per cycle — see findStaleSources for why quota makes this matter. */
const SOURCES_PER_RUN = 20;
const STALE_AFTER_HOURS = 24;

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
  const stale = await findStaleSources({
    olderThanHours: STALE_AFTER_HOURS,
    limit: SOURCES_PER_RUN,
  });

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
      await markSourceFailed(source.id, `Unparseable URI: ${source.uri}`);
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
          if (source) await markSourceFailed(source.id, result.error);
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
