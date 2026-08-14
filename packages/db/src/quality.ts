import { getPool } from "./client.js";
import { NON_PATTERN_INTENTS } from "@nexus/shared";

/**
 * Agent quality, measured by what humans did rather than by what the AI thinks.
 *
 * Every figure here comes from an action a person took — taking a conversation
 * over, replying straight after the agent, or not intervening at all. None of it
 * comes from the agent's own assessment of its answers, which would rise with
 * fluency and say nothing about whether anyone was helped.
 *
 * See migration 019 for why the table is shaped this way.
 */

export interface QualityDay {
  day: string;
  conversations: number;
  inboundMessages: number;
  aiMessages: number;
  humanMessages: number;
  aiAnswered: number;
  escalated: number;
  aiOnly: number;
  corrections: number;
  inputTokens: number;
  outputTokens: number;
  isComplete: boolean;
}

/**
 * Recomputes one day for one business, replacing whatever was there.
 *
 * Recomputation rather than incremental accumulation is the whole point: a
 * rollup that double-counts on re-run stays plausible while being wrong, and a
 * plausible wrong number is this system's signature failure. Re-running this
 * for the same day is a no-op in effect.
 *
 * `day` is a date in the organization's own timezone. Rolling up in UTC would
 * put a Dubai evening conversation on the following day, and every daily figure
 * would be quietly shifted by four hours.
 */
export async function rollUpQualityDay(organizationId: string, day: string): Promise<void> {
  await getPool().query(
    `with tz as (
       select coalesce(timezone, 'UTC') as zone from organizations where id = $1
     ),
     bounds as (
       select ($2::date)::timestamp at time zone (select zone from tz)               as day_start,
              ($2::date + 1)::timestamp at time zone (select zone from tz)           as day_end
     ),
     -- Conversations that saw inbound traffic that day. A conversation opened
     -- weeks ago and replied to today belongs to today, which is why this keys
     -- off message time rather than conversation.opened_at.
     day_messages as (
       select m.conversation_id, m.sender_type, m.created_at
         from messages m, bounds b
        where m.organization_id = $1
          and m.created_at >= b.day_start
          and m.created_at <  b.day_end
     ),
     per_conversation as (
       select conversation_id,
              count(*) filter (where sender_type = 'contact')      as inbound,
              count(*) filter (where sender_type = 'ai_agent')     as ai,
              count(*) filter (where sender_type = 'human_agent')  as human
         from day_messages
        group by conversation_id
     ),
     -- A human message whose immediately preceding message in the same
     -- conversation came from the AI. That adjacency is what distinguishes
     -- "the human corrected the agent" from "the human handled a later,
     -- unrelated question in the same thread".
     corrections as (
       select count(*) as n
         from (
           select sender_type,
                  lag(sender_type) over (
                    partition by conversation_id order by created_at
                  ) as previous
             from day_messages
         ) adjacency
        where sender_type = 'human_agent' and previous = 'ai_agent'
     ),
     tokens as (
       select coalesce(sum(cm.input_tokens), 0)  as input_tokens,
              coalesce(sum(cm.output_tokens), 0) as output_tokens
         from conversation_metrics cm, bounds b
        where cm.organization_id = $1
          and cm.recorded_at >= b.day_start
          and cm.recorded_at <  b.day_end
     )
     insert into agent_quality_daily (
       organization_id, day, conversations, inbound_messages, ai_messages, human_messages,
       ai_answered, escalated, ai_only, corrections, input_tokens, output_tokens,
       is_complete, computed_at
     )
     select $1,
            $2::date,
            (select count(*) from per_conversation),
            (select coalesce(sum(inbound), 0) from per_conversation),
            (select coalesce(sum(ai), 0)      from per_conversation),
            (select coalesce(sum(human), 0)   from per_conversation),
            (select count(*) from per_conversation where ai > 0),
            (select count(*) from per_conversation where ai > 0 and human > 0),
            (select count(*) from per_conversation where ai > 0 and human = 0),
            (select n from corrections),
            (select input_tokens from tokens),
            (select output_tokens from tokens),
            -- Complete once the day is over in the business's own timezone.
            (select day_end from bounds) <= now(),
            now()
     on conflict (organization_id, day) do update
       set conversations    = excluded.conversations,
           inbound_messages = excluded.inbound_messages,
           ai_messages      = excluded.ai_messages,
           human_messages   = excluded.human_messages,
           ai_answered      = excluded.ai_answered,
           escalated        = excluded.escalated,
           ai_only          = excluded.ai_only,
           corrections      = excluded.corrections,
           input_tokens     = excluded.input_tokens,
           output_tokens    = excluded.output_tokens,
           is_complete      = excluded.is_complete,
           computed_at      = now()`,
    [organizationId, day]
  );
}

export async function getQualityTrend(organizationId: string, days = 30): Promise<QualityDay[]> {
  const { rows } = await getPool().query<{
    day: string;
    conversations: number;
    inbound_messages: number;
    ai_messages: number;
    human_messages: number;
    ai_answered: number;
    escalated: number;
    ai_only: number;
    corrections: number;
    input_tokens: string;
    output_tokens: string;
    is_complete: boolean;
  }>(
    `select day, conversations, inbound_messages, ai_messages, human_messages,
            ai_answered, escalated, ai_only, corrections,
            input_tokens::text, output_tokens::text, is_complete
       from agent_quality_daily
      where organization_id = $1
        and day > current_date - $2::integer
      order by day asc`,
    [organizationId, days]
  );

  return rows.map((row) => ({
    day: typeof row.day === "string" ? row.day : new Date(row.day).toISOString().slice(0, 10),
    conversations: row.conversations,
    inboundMessages: row.inbound_messages,
    aiMessages: row.ai_messages,
    humanMessages: row.human_messages,
    aiAnswered: row.ai_answered,
    escalated: row.escalated,
    aiOnly: row.ai_only,
    corrections: row.corrections,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    isComplete: row.is_complete,
  }));
}

export interface QualitySummary {
  days: number;
  conversations: number;
  aiAnswered: number;
  escalated: number;
  corrections: number;
  outputTokens: number;
  /** Share of AI-answered conversations a human had to join. Null when there is nothing to divide. */
  escalationRate: number | null;
  /** Share the AI closed without any human message. */
  containmentRate: number | null;
}

/**
 * Totals over the window.
 *
 * Rates are null rather than zero when the denominator is zero. A business with
 * no conversations has no escalation rate; rendering that as 0% would read as
 * flawless performance, which is the opposite of what it means — and on this
 * platform four of five businesses currently have no traffic at all.
 */
export function summarise(trend: QualityDay[]): QualitySummary {
  const total = trend.reduce(
    (acc, day) => ({
      conversations: acc.conversations + day.conversations,
      aiAnswered: acc.aiAnswered + day.aiAnswered,
      escalated: acc.escalated + day.escalated,
      corrections: acc.corrections + day.corrections,
      outputTokens: acc.outputTokens + day.outputTokens,
    }),
    { conversations: 0, aiAnswered: 0, escalated: 0, corrections: 0, outputTokens: 0 }
  );

  return {
    days: trend.length,
    ...total,
    escalationRate: total.aiAnswered > 0 ? total.escalated / total.aiAnswered : null,
    containmentRate: total.aiAnswered > 0 ? (total.aiAnswered - total.escalated) / total.aiAnswered : null,
  };
}

export interface EscalationHotspot {
  intent: string;
  conversations: number;
  escalated: number;
  escalationRate: number;
}

/**
 * Which kinds of enquiry most often end up with a human, for one business.
 *
 * This is the half of F14 that acts on the measurement rather than reporting
 * it. The intended use is to point at a knowledge gap: if attestation questions
 * escalate four times out of five, the agent probably cannot answer them, and
 * the fix is a page on the Knowledge screen rather than a prompt change.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. A high rate is not evidence the agent
 * is failing. Some enquiries *should* reach a person — a live dispute at a law
 * firm ought to escalate every time, and an agent that stopped doing so would
 * be worse, not better. So this returns the ranking and nothing else; the
 * judgement of whether a given rate is wrong belongs to someone who knows the
 * business. Naming it "hotspots" rather than "failures" is the same decision.
 *
 * `minConversations` is not optional in spirit. An intent seen three times with
 * two escalations reads as 67% and means nothing; ranking it above a
 * well-sampled intent would send someone to fix a problem that does not exist.
 */
export async function getEscalationHotspots(
  organizationId: string,
  days = 30,
  minConversations = 5
): Promise<EscalationHotspot[]> {
  const { rows } = await getPool().query<{
    intent: string;
    conversations: string;
    escalated: string;
  }>(
    `with per_conversation as (
       -- Collapsed to one row per conversation first: without this a chatty
       -- conversation would contribute several times and the rate would track
       -- verbosity rather than escalation.
       select conversation_id,
              min(intent)                             as intent,
              bool_or(resolved_by = 'human_agent')    as escalated
         from conversation_metrics
        where organization_id = $1
          and intent is not null
          -- Same exclusion as the F5 rollup, for a sharper version of the same
          -- reason. This ranking exists to send someone to fix a knowledge gap.
          -- inbound_pitch is spam and is the largest share of traffic on this
          -- number, so it would head the list and send them to write a help
          -- page for spammers; unknown is not an enquiry type at all, and "fix
          -- the unknown intent" is not an action anyone can take.
          and intent <> all($4::text[])
          and recorded_at > now() - ($2::integer * interval '1 day')
        group by conversation_id
     )
     select intent,
            count(*)::text                              as conversations,
            count(*) filter (where escalated)::text     as escalated
       from per_conversation
      group by intent
     having count(*) >= $3
      order by (count(*) filter (where escalated))::numeric / count(*) desc, count(*) desc
      limit 8`,
    [organizationId, days, minConversations, NON_PATTERN_INTENTS]
  );

  return rows.map((row) => ({
    intent: row.intent,
    conversations: Number(row.conversations),
    escalated: Number(row.escalated),
    escalationRate: Number(row.escalated) / Number(row.conversations),
  }));
}
