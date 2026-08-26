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

/**
 * How long to wait when the failure looks transient.
 *
 * ============================================================
 * THIS IS NOT THE TAXONOMY THE COMMENT ABOVE REFUSES
 * ============================================================
 *
 * That refusal is right and stands: classifying provider errors in general
 * means owning a vocabulary somebody else changes, and it rots.
 *
 * This is one bit, and it is not the provider's vocabulary. The question is
 * not "what kind of error is this" but "did the server ANSWER" — see
 * shouldRetrySoon, which is where that line is drawn and why.
 *
 * AND IT FAILS SAFE, which is what makes it worth having at all: if the
 * wording ever stops matching, the delay falls back to the 24 hours above.
 * The narrowing can stop working; it cannot make anything worse.
 *
 * Measured on 2026-08-26. The embedding provider's free tier hit its quota
 * and returned 429 for five of ABR's pages -- litigation, maritime law,
 * property law, our expertise, overview, which is most of what a law firm
 * does. The quota had cleared within the hour and those pages were still
 * going to serve stale content for another twenty-three, on a key that will
 * hit the same limit again tomorrow.
 */
const RETRY_TRANSIENT_AFTER_HOURS = 1;

/**
 * Did we get a DEFINITIVE answer, or should we come back soon?
 *
 * ============================================================
 * ONE BIT, AND THIS IS THE HONEST PLACE TO CUT IT
 * ============================================================
 *
 * The first version of this asked only "did the other end say 429". That was
 * right about rate limits and wrong about the commoner case, found within the
 * hour: SFS's terms page failed with a bare "fetch failed" in 313ms, and
 * answered 200 twice when asked again ninety seconds later. An intermittent
 * connection reset had cost that page a day of staleness -- and a warn-level
 * broken-knowledge finding for the same day, which is the noise that teaches
 * somebody to stop reading the operator list.
 *
 * The line that holds is not a taxonomy of errors. It is whether the server
 * ANSWERED. A 404 or a 410 is a definitive answer and deserves the full
 * cooldown: the page is gone and asking hourly will not bring it back. A
 * reset connection, a DNS failure, a timeout or a 503 is the absence of an
 * answer, and the absence of an answer is transient until proven otherwise.
 *
 * Still deliberately narrow, and still failing safe: anything unrecognised
 * waits the full cooldown, which is the behaviour this had before any of the
 * distinction existed.
 */
export function shouldRetrySoon(error: string | null | undefined): boolean {
  if (!error) return false;
  const text = error.toLowerCase();

  // A definitive answer wins, even if the text also mentions something
  // transient-looking. "404 Not Found" for a page whose URL contains the word
  // "quota" must not be read as a rate limit.
  for (const definitive of ["404", "410", "not found", "gone", "unsupported content-type", "unparseable uri", "refusing to fetch"]) {
    if (text.includes(definitive)) return false;
  }

  return (
    // The other end asked us to wait.
    text.includes("429") ||
    text.includes("503") ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("service unavailable") ||
    // Or never answered at all.
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("etimedout") ||
    text.includes("eai_again") ||
    text.includes("socket hang up") ||
    text.includes("network") ||
    text.includes("timeout")
  );
}


/** When a source that just failed should next be tried. */
export function retryAfterFor(error: string | null | undefined, now = new Date()): Date {
  const hours = shouldRetrySoon(error)
    ? RETRY_TRANSIENT_AFTER_HOURS
    : RETRY_FAILED_AFTER_HOURS;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

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
              -- And a failed one, once it is due. Without this a 429 removes a
              -- page from the knowledge base permanently.
              --
              -- retry_after is written when the failure HAPPENS, so a rate
              -- limit comes back in an hour and everything else still waits
              -- the full cooldown. Null is a row that failed before the column
              -- existed and keeps the old rule -- which is also the fallback if
              -- the narrowing ever stops recognising anything.
              --
              -- (No backticks in this comment: it lives inside a template
              -- literal and one would end the string. Written here after doing
              -- exactly that, despite the same warning already standing in
              -- operators.ts.)
              or (status = 'failed'
                  and (last_checked_at is null
                       or (retry_after is not null and retry_after <= now())
                       or (retry_after is null
                           and last_checked_at < now() - ($3 || ' hours')::interval)))
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
     set status = 'failed', error = $2, last_checked_at = now(), retry_after = $3
     where id = $1`,
    // Decided HERE, once, rather than re-derived from the stored text by
    // whoever reads it. The error string is the provider's and may be
    // reworded; the moment it arrived is when we knew what it meant.
    [sourceId, error.slice(0, 500), retryAfterFor(error)]
  );
}
