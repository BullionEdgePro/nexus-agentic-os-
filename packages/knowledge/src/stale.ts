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
       and status <> 'failed'
       and (last_checked_at is null or last_checked_at < now() - ($1 || ' hours')::interval)
     order by last_checked_at asc nulls first
     limit $2`,
    [String(olderThanHours), limit]
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
