import { getPool } from "./client.js";
import { withAllTenants } from "./client.js";

/**
 * The Neural Brain's store (F5).
 *
 * Pools structured outcomes across businesses so a tenant with no history can
 * still be told that a given kind of enquiry usually needs a human. Nothing a
 * customer or employee wrote is in here — see migration 020 and the SHAREABLE
 * allow-list in packages/governance.
 *
 * Read the `contributing_tenants` guard in that migration before changing
 * anything in this file. It is the difference between shared learning and one
 * business's data handed back to it wearing a platform badge.
 */

export interface SharedPattern {
  intentCategory: string;
  language: string;
  sampleCount: number;
  escalatedCount: number;
  escalationRate: number;
  avgResolutionSeconds: number | null;
  contributingTenants: number;
}

/**
 * Recomputes the pooled table from every tenant's conversation metrics.
 *
 * Cross-tenant on purpose, and one of the very few places that is: the whole
 * output is an aggregate across businesses, so there is no tenant to scope to.
 * Stated with `withAllTenants` rather than left implicit, so it shows up when
 * someone greps for queries that span the platform.
 *
 * Recomputed rather than accumulated, for the same reason as the quality
 * rollups: a counter that double-counts on re-run stays plausible while being
 * wrong.
 */
export async function rollUpSharedPatterns(): Promise<{ patterns: number; shareable: number }> {
  return withAllTenants("F5 shared patterns: an aggregate across every business", async () => {
    await getPool().query(
      `with per_conversation as (
         -- One row per conversation, so a chatty conversation does not weigh
         -- more than a brief one when the rate is computed.
         select cm.organization_id,
                cm.conversation_id,
                min(cm.intent)                                       as intent,
                max(cm.resolution_ms)                                as resolution_ms,
                count(*)                                             as metric_rows,
                bool_or(cm.resolved_by = 'human_agent')              as escalated
           from conversation_metrics cm
          where cm.intent is not null
          group by cm.organization_id, cm.conversation_id
       ),
       labelled as (
         select p.*,
                coalesce(o.timezone, 'UTC') as tz,
                -- Language is not recorded per conversation, so it is carried
                -- as the tenant default rather than guessed per message. A
                -- wrong label here would split one pattern into two that each
                -- look thinner than the truth.
                'en'::text as language
           from per_conversation p
           join organizations o on o.id = p.organization_id
       )
       insert into shared_patterns (
         intent_category, language, sample_count, escalated_count,
         avg_resolution_seconds, avg_message_count, contributing_tenants, computed_at
       )
       select intent,
              language,
              count(*),
              count(*) filter (where escalated),
              (avg(resolution_ms) / 1000)::int,
              avg(metric_rows)::numeric(6,2),
              count(distinct organization_id),
              now()
         from labelled
        group by intent, language
       on conflict (intent_category, language) do update
         set sample_count           = excluded.sample_count,
             escalated_count        = excluded.escalated_count,
             avg_resolution_seconds = excluded.avg_resolution_seconds,
             avg_message_count      = excluded.avg_message_count,
             contributing_tenants   = excluded.contributing_tenants,
             computed_at            = now()`
    );

    const { rows } = await getPool().query<{ total: string; shareable: string }>(
      `select count(*)::text                                       as total,
              count(*) filter (where contributing_tenants >= 2)::text as shareable
         from shared_patterns`
    );

    return { patterns: Number(rows[0].total), shareable: Number(rows[0].shareable) };
  });
}

/** A pattern only counts as cross-tenant learning once two businesses agree. */
export const MIN_CONTRIBUTING_TENANTS = 2;

/**
 * Patterns that genuinely came from more than one business.
 *
 * The filter is the entire point. Returning everything and letting the caller
 * decide would mean the first careless caller presents one tenant's own history
 * back to it as platform knowledge — and nobody downstream could tell.
 *
 * `minSamples` guards the other end: two businesses and three conversations is
 * still noise, and an escalation rate computed from three samples will swing
 * wildly and read as a trend.
 */
export async function getSharedGuidance(minSamples = 20): Promise<SharedPattern[]> {
  const { rows } = await getPool().query<{
    intent_category: string;
    language: string;
    sample_count: number;
    escalated_count: number;
    avg_resolution_seconds: number | null;
    contributing_tenants: number;
  }>(
    `select intent_category, language, sample_count, escalated_count,
            avg_resolution_seconds, contributing_tenants
       from shared_patterns
      where contributing_tenants >= $1
        and sample_count >= $2
      order by sample_count desc`,
    [MIN_CONTRIBUTING_TENANTS, minSamples]
  );

  return rows.map((row) => ({
    intentCategory: row.intent_category,
    language: row.language,
    sampleCount: row.sample_count,
    escalatedCount: row.escalated_count,
    escalationRate: row.sample_count > 0 ? row.escalated_count / row.sample_count : 0,
    avgResolutionSeconds: row.avg_resolution_seconds,
    contributingTenants: row.contributing_tenants,
  }));
}

export interface BrainStatus {
  patternsStored: number;
  patternsShareable: number;
  contributingTenants: number;
  /** Plain-language reason the brain has nothing to offer, or null when it does. */
  blockedBecause: string | null;
}

/**
 * Why the brain is or is not useful yet.
 *
 * Exists so the answer to "why is this empty?" is a sentence rather than an
 * absence. An empty pooled table is indistinguishable from a broken one unless
 * it says which it is.
 */
export async function getBrainStatus(): Promise<BrainStatus> {
  const { rows } = await getPool().query<{
    stored: string;
    shareable: string;
    max_tenants: string | null;
  }>(
    `select count(*)::text                                          as stored,
            count(*) filter (where contributing_tenants >= 2)::text as shareable,
            max(contributing_tenants)::text                         as max_tenants
       from shared_patterns`
  );

  const stored = Number(rows[0].stored);
  const shareable = Number(rows[0].shareable);
  const contributing = Number(rows[0].max_tenants ?? 0);

  let blockedBecause: string | null = null;
  if (stored === 0) {
    blockedBecause = "No conversations have been classified into an intent yet.";
  } else if (shareable === 0) {
    blockedBecause =
      contributing <= 1
        ? "Only one business has customer traffic, so nothing here is cross-tenant learning yet — it would just be that business's own history handed back to it."
        : "Patterns exist but none has enough samples to be worth acting on.";
  }

  return {
    patternsStored: stored,
    patternsShareable: shareable,
    contributingTenants: contributing,
    blockedBecause,
  };
}
