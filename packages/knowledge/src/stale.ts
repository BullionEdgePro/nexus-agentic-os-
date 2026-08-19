import { getPool } from "@nexus/db";

export interface StaleSource {
  id: string;
  organizationId: string;
  employeeId: string | null;
  uri: string;
  title: string;
}

/**
 * URL-backed sources that have not been checked recently.
 *
 * A knowledge base that is never refreshed degrades into confident
 * misinformation: the retrieval layer will keep citing a return policy that
 * changed months ago, and the citation makes the stale answer *more*
 * believable, not less. Freshness is a correctness property here, not a
 * nice-to-have.
 *
 * Only `kind = 'url'` is refreshable — inline text and uploaded files have no
 * origin to re-fetch, so they are excluded rather than repeatedly marked stale.
 *
 * `limit` bounds the work per run. Embeddings are rate-limited on the free
 * tier, so a large batch of genuinely-changed pages could exhaust quota and
 * take the live reply path down with it; refreshing a few sources every cycle
 * is strictly better than refreshing all of them once and breaking replies.
 */
/**
 * How long a FAILED source is left alone before it is tried again.
 *
 * `status <> 'failed'` used to be absolute, which made every failure permanent.
 * That is right for a page that is genuinely broken and wrong for the far more
 * common case: on 2026-08-18 the first successful scheduled re-index had a
 * backlog of twenty stale sources to re-embed at once, exhausted the free tier's
 * daily embedding quota, and Gemini returned 429 for the last eight. All eight
 * belonged to ABR, all eight were marked failed, and because the sweep excluded
 * failed sources they were never retried — 53 of ABR's 72 passages sat
 * unreachable behind a status column for sixteen hours, while `broken-knowledge`
 * correctly reported it to nobody.
 *
 * A transient provider error should heal itself. A permanently broken page
 * should stay reported. Retrying after a cooldown does both WITHOUT having to
 * classify errors — which is the part that would rot, because the taxonomy is
 * the provider's and it changes.
 *
 * Longer than the ordinary staleness window on purpose: a page that fails every
 * time should cost one attempt a day, not one every cycle.
 */
const RETRY_FAILED_AFTER_HOURS = 24;

export async function findStaleSources(input: {
  olderThanHours?: number;
  limit?: number;
} = {}): Promise<StaleSource[]> {
  const olderThanHours = input.olderThanHours ?? 24;
  const limit = input.limit ?? 20;

  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    employee_id: string | null;
    uri: string;
    title: string;
  }>(
    `select id, organization_id, employee_id, uri, title
       from knowledge_sources
      where kind = 'url'
        and uri is not null
        and (
              -- The ordinary case: a healthy source that has not been checked
              -- recently.
              (status <> 'failed'
               and (last_checked_at is null
                    or last_checked_at < now() - ($1 || ' hours')::interval))
              -- And a failed one, once its cooldown has passed. Without this a
              -- 429 removes a page from the knowledge base permanently.
              or (status = 'failed'
                  and (last_checked_at is null
                       or last_checked_at < now() - ($3 || ' hours')::interval))
            )
      -- HEALTHY SOURCES FIRST. Ordering by staleness alone would put the failed
      -- ones at the front — they are by definition the least recently
      -- successful — and a handful of permanently broken pages would consume
      -- the whole per-run budget every cycle, starving the refreshes that work.
      order by (status = 'failed'), last_checked_at asc nulls first
      limit $2`,
    [String(olderThanHours), limit, String(RETRY_FAILED_AFTER_HOURS)]
  );

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    employeeId: row.employee_id,
    uri: row.uri,
    title: row.title,
  }));
}

/**
 * Record that a refresh failed without discarding the source.
 *
 * A source stuck in 'failed' with its error is diagnosable and recoverable; a
 * deleted one is neither. Excluded from future stale sweeps so one permanently
 * dead URL cannot consume the batch budget on every cycle.
 */
export async function markSourceFailed(sourceId: string, error: string): Promise<void> {
  await getPool().query(
    `update knowledge_sources
     set status = 'failed', error = $2, last_checked_at = now()
     where id = $1`,
    [sourceId, error.slice(0, 500)]
  );
}
