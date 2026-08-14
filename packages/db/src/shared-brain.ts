import { getPool } from "./client.js";
import { withAllTenants } from "./client.js";
import { NON_PATTERN_INTENTS } from "@nexus/shared";

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
            -- unknown and inbound_pitch are correct classifications that must
            -- not become patterns: one is the absence of a category, the other
            -- is spam, and spam is the largest single share of traffic on this
            -- number. Pooled, either would cross the sample threshold long
            -- before anything real did and become the first thing the Neural
            -- Brain ever said. See NON_PATTERN_INTENTS.
            and cm.intent <> all($1::text[])
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
             computed_at            = now()`,
      [NON_PATTERN_INTENTS]
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
  /** How much of the traffic F5 can actually read. See IntentCoverage. */
  coverage: IntentCoverage;
}

/**
 * How many conversations reached F5 with a usable intent.
 *
 * THE NUMBER THAT WAS MISSING, and whose absence hid the real defect for the
 * whole life of this feature. F5 could only ever pool conversations carrying an
 * intent, intent was derived from tool calls alone, and 83% of production
 * traffic fires no tool — so the store was reading a sixth of the platform and
 * reporting an empty result that looked exactly like "not enough tenants yet".
 * Both are empty; only one is fixable by waiting.
 *
 * `neverClassified` is the one to watch. It counts conversations whose metrics
 * carry a NULL intent, which nothing in the reply path writes any more — so it
 * should only ever be historical rows. Rising, it means the classifier stopped
 * running, and that is a defect rather than a quiet week.
 */
export interface IntentCoverage {
  conversations: number;
  /** Conversations with an intent that can become a pattern. */
  classified: number;
  /** Classified honestly, but as `unknown` or `inbound_pitch`. Not poolable. */
  nonPatternOnly: number;
  /** Intent is NULL — the classifier did not run. A defect, not a quiet week. */
  neverClassified: number;
  /** classified / conversations, 0 when there is no traffic at all. */
  rate: number;
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
  const coverage = await getIntentCoverage();

  // Ordered by which constraint actually binds first, because the whole value
  // of this string is telling someone which of them to go and fix. Coverage is
  // checked BEFORE the tenant count: a platform that cannot read its own
  // traffic is not waiting for a second business, and saying "only one business
  // has traffic" while five sixths of that business's conversations are
  // unreadable sends the reader to wait for something that would not help.
  let blockedBecause: string | null = null;
  if (coverage.conversations === 0) {
    blockedBecause = "No conversations have been handled yet, so there is nothing to learn from.";
  } else if (coverage.classified === 0) {
    blockedBecause =
      "No conversation has been classified into a poolable intent yet — the rules could not place any of them, so there is nothing to pool. This is a gap in classification, not in traffic.";
  } else if (stored === 0) {
    blockedBecause =
      "Conversations are classified but no pattern has been computed yet — the rollup has not run since they arrived.";
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
    coverage,
  };
}

/**
 * Per CONVERSATION, not per metric row — matching how the rollup counts, so the
 * two views of the same source cannot disagree. A chatty conversation is one
 * conversation in both.
 *
 * Cross-tenant and says so: coverage is a property of the platform, and
 * `conversation_metrics` is tenant-scoped, so without this wrapper the query
 * throws under `DB_TENANT_ASSERT=strict` on the unscoped `/quality/shared`
 * route — which is exactly what that assertion is for.
 */
export async function getIntentCoverage(): Promise<IntentCoverage> {
  return withAllTenants("F5 intent coverage: how much of the platform F5 can read", async () => {
    const { rows } = await getPool().query<{
      conversations: string;
      classified: string;
      non_pattern_only: string;
      never_classified: string;
    }>(
      `with per_conversation as (
         select conversation_id,
                bool_or(intent is not null and intent <> all($1::text[])) as any_pattern,
                bool_or(intent = any($1::text[]))                         as any_non_pattern,
                bool_or(intent is null)                                   as any_null
           from conversation_metrics
          group by conversation_id
       )
       select count(*)::text                                              as conversations,
              count(*) filter (where any_pattern)::text                   as classified,
              count(*) filter (where not any_pattern and any_non_pattern)::text
                                                                          as non_pattern_only,
              count(*) filter (where not any_pattern and not any_non_pattern and any_null)::text
                                                                          as never_classified
         from per_conversation`,
      [NON_PATTERN_INTENTS]
    );

    const conversations = Number(rows[0].conversations);
    const classified = Number(rows[0].classified);

    return {
      conversations,
      classified,
      nonPatternOnly: Number(rows[0].non_pattern_only),
      neverClassified: Number(rows[0].never_classified),
      rate: conversations > 0 ? classified / conversations : 0,
    };
  });
}
