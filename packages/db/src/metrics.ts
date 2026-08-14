import { getPool } from "./client.js";
import type { ConversationMetricInput, OverviewMetrics, SenderType } from "@nexus/shared";
import { NON_PATTERN_INTENTS } from "@nexus/shared";

/**
 * Records one analytics row per handled inbound message: token spend,
 * who resolved it, the classified intent, and time-to-first-response.
 * This is the only writer of conversation_metrics — callers treat a failure
 * here as non-fatal (analytics must never take down the reply pipeline).
 */
export async function recordConversationMetric(input: ConversationMetricInput): Promise<void> {
  await getPool().query(
    `insert into conversation_metrics
       (organization_id, conversation_id, intent, resolved_by,
        input_tokens, output_tokens, first_response_ms, resolution_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.organizationId,
      input.conversationId,
      input.intent ?? null,
      input.resolvedBy,
      input.inputTokens,
      input.outputTokens,
      input.firstResponseMs ?? null,
      input.resolutionMs ?? null,
    ]
  );
}

/**
 * Real aggregate snapshot for the command-deck overview. All counts are live;
 * `hasData` is false on a fresh system with no traffic yet, letting the UI
 * fall back to illustrative sample figures until real conversations arrive.
 */
export async function getOverviewMetrics(): Promise<OverviewMetrics> {
  const pool = getPool();
  const [conv, msgs, res, tok, gov, intents, tenants, feed, any] = await Promise.all([
    pool.query<{ n: string }>(`select count(*)::text n from conversations where status in ('open','pending')`),
    pool.query<{ n: string }>(`select count(*)::text n from messages where created_at >= current_date`),
    pool.query<{ ai: string; total: string; avgms: string | null }>(
      `select count(*) filter (where resolved_by = 'ai_agent')::text ai,
              count(*)::text total,
              avg(first_response_ms)::int::text avgms
       from conversation_metrics
       where recorded_at >= now() - interval '7 days'`
    ),
    pool.query<{ t: string }>(
      `select coalesce(sum(input_tokens + output_tokens), 0)::text t
       from conversation_metrics where recorded_at >= now() - interval '7 days'`
    ),
    pool.query<{ n: string }>(
      `select count(*)::text n from ai_message_evaluations
       where evaluated_at >= now() - interval '24 hours' and (pii_flagged or hallucination_risk = 'high')`
    ),
    // "What are customers asking about" — so the same exclusion as the F5
    // rollup and the escalation hotspots. unknown is not a subject and
    // inbound_pitch is not a customer; together they are the majority of
    // traffic, and unfiltered they would fill most of a six-slot chart with
    // neither. How much traffic they account for is a real number, but it is a
    // coverage number and it is reported as one — see getIntentCoverage.
    pool.query<{ intent: string | null; c: string }>(
      `select intent, count(*)::text c from conversation_metrics
       where recorded_at >= now() - interval '7 days' and intent is not null
         and intent <> all($1::text[])
       group by intent order by count(*) desc limit 6`,
      [NON_PATTERN_INTENTS]
    ),
    pool.query<{ slug: string; name: string; mc: string; oc: string }>(
      `select o.slug, o.name,
         (select count(*) from messages m where m.organization_id = o.id and m.created_at >= now() - interval '7 days')::text mc,
         (select count(*) from conversations c where c.organization_id = o.id and c.status in ('open','pending'))::text oc
       from organizations o order by o.created_at asc`
    ),
    pool.query<{ org: string; sender_type: SenderType; body: string; created_at: string }>(
      `select o.name org, m.sender_type, m.body, m.created_at
       from messages m join organizations o on o.id = m.organization_id
       where m.direction = 'outbound' and m.body is not null
       order by m.created_at desc limit 5`
    ),
    pool.query<{ n: string }>(`select (select count(*) from messages)::text n`),
  ]);

  const total = Number(res.rows[0]?.total ?? 0);
  const ai = Number(res.rows[0]?.ai ?? 0);
  return {
    hasData: Number(any.rows[0]?.n ?? 0) > 0,
    activeConversations: Number(conv.rows[0]?.n ?? 0),
    messagesToday: Number(msgs.rows[0]?.n ?? 0),
    aiResolutionPct: total > 0 ? Math.round((ai / total) * 100) : null,
    avgFirstResponseMs: res.rows[0]?.avgms ? Number(res.rows[0].avgms) : null,
    governanceHolds: Number(gov.rows[0]?.n ?? 0),
    tokensUsed: Number(tok.rows[0]?.t ?? 0),
    intents: intents.rows.map((r) => ({ intent: r.intent ?? "unknown", count: Number(r.c) })),
    tenants: tenants.rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      messageCount: Number(r.mc),
      openConversations: Number(r.oc),
    })),
    feed: feed.rows.map((r) => ({
      org: r.org,
      senderType: r.sender_type,
      body: r.body,
      createdAt: r.created_at,
    })),
  };
}
