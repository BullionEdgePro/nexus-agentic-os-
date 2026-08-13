import {
  getPool,
  listOrganizations,
  reconcileFindings,
  withTenant,
  type FindingInput,
} from "@nexus/db";
// Pure and rules-based — no model call, so using it here keeps operators within
// the property that makes them cheap enough to run every ten minutes.
import { scoreLead } from "@nexus/leads";
import { JUDGE_UNAVAILABLE } from "@nexus/governance";
import { logger } from "../lib/logger.js";

/**
 * Operators (F8) — the first things this platform does without being asked.
 *
 * Everything before this was reactive: a customer messages, an agent replies.
 * An operator watches for a condition and reports it, on a schedule, whether or
 * not anybody is looking.
 *
 * ============================================================
 * WHY NONE OF THESE CALLS A MODEL
 * ============================================================
 *
 * ARCHITECTURE-ABOS.md §2.3 blocked F8 on a question — "event-triggered, or
 * paid inference?" — because autonomous agents that poll a model produce an
 * inference bill scaling with tenants AND with time, on a deployment whose
 * agents run on a free tier. Every operator below is SQL over data the platform
 * already holds. That does not answer the question; it removes the need to
 * answer it before anything ships, and leaves the expensive version to be added
 * deliberately rather than by default.
 *
 * ============================================================
 * THE RULE EVERY OPERATOR FOLLOWS
 * ============================================================
 *
 * An operator returns the COMPLETE set of things currently wrong, not a stream
 * of alerts. `reconcileFindings` then opens what is new, touches what still
 * holds, and RETRACTS what no longer does. An operator that could only raise
 * would build a list that only grows, and a list that only grows stops being
 * read — while continuing to look like a working feature.
 *
 * ============================================================
 * AND THE RULE ABOUT WHAT NOT TO REPORT
 * ============================================================
 *
 * A finding nobody can act on is noise, and noise is what teaches people to
 * ignore the ones that matter. `unowned-followup` therefore stays silent for a
 * business with no staff: with nobody to assign work to, "this is unassigned"
 * is not a task, it is a description of the business. The actionable version of
 * that fact is a different sentence, and it is not this operator's to say.
 */

export interface Operator {
  slug: string;
  /** Shown on the page, so a reader knows what is watching them. */
  title: string;
  description: string;
  /** Returns everything currently wrong for this business. */
  run: (organizationId: string) => Promise<FindingInput[]>;
}

/** Hours a customer may wait before it is worth someone's attention. */
const WAITING_WARN_HOURS = 2;
const WAITING_URGENT_HOURS = 24;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A customer who wrote and got nothing back.
 *
 * The most valuable of these by some distance. In normal operation the agent
 * replies in seconds, so this only fires when the AI is paused for a human
 * handoff and the human has not arrived, or when the reply pipeline failed
 * silently. Both are precisely the states nobody finds out about on their own —
 * the conversation just sits there looking like every other conversation.
 *
 * Keyed on the conversation rather than the message: a customer who sends three
 * messages while waiting has one problem, not three.
 */
const customerWaiting: Operator = {
  slug: "customer-waiting",
  title: "Customer waiting",
  description:
    "Someone messaged and nothing has gone back. Normally the agent answers in seconds, so this means the AI is paused for a handover nobody picked up, or the reply path failed.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      conversation_id: string;
      contact_name: string | null;
      wa_id: string;
      waited_hours: string;
      is_human_handoff: boolean;
      last_body: string | null;
      has_assessment: boolean;
    }>(
      `select c.id as conversation_id,
              ct.display_name as contact_name,
              ct.wa_id,
              round(extract(epoch from (now() - last.created_at)) / 3600.0, 1)::text as waited_hours,
              c.is_human_handoff,
              last.body as last_body,
              exists (
                select 1 from lead_assessments la where la.conversation_id = c.id
              ) as has_assessment
         from conversations c
         join contacts ct on ct.id = c.contact_id
         join lateral (
           select sender_type, created_at, body
             from messages m
            where m.conversation_id = c.id
            -- THE TIEBREAK IS NOT COSMETIC.
            --
            -- created_at is not unique. An agent reply generated in response to
            -- an inbound message can land on the identical microsecond, and
            -- "order by created_at desc limit 1" then picks between them
            -- arbitrarily. This operator's very first run on production
            -- reported a customer as ignored when the triage reply had in fact
            -- gone out at the same instant — a false positive produced by a
            -- coin flip, on exactly the kind of alert that has to be trusted.
            --
            -- Ordering outbound first on a tie is the correct reading, not just
            -- a deterministic one: an outbound message sharing a timestamp with
            -- an inbound one was written in reply to it, so it came after.
            order by m.created_at desc,
                     case when m.direction = 'outbound' then 0 else 1 end
            limit 1
         ) last on true
        where c.organization_id = $1
          and c.status in ('open', 'pending')
          -- The last thing said was said BY THE CUSTOMER. That is what makes
          -- this "waiting" rather than "quiet".
          and last.sender_type = 'contact'
          and last.created_at < now() - ($2 || ' hours')::interval
          -- Cold pitches are not customers kept waiting.
          --
          -- The lead scorer already classifies "somebody selling TO us" as
          -- inbound_pitch, and this platform receives a steady trickle of them.
          -- Reporting an unanswered sales pitch as an ignored customer is the
          -- noise that teaches an operator to stop reading the list.
          --
          -- Keyed on that AFFIRMATIVE classification, deliberately — not on a
          -- score of zero or a low priority. A genuine customer writing in a
          -- language the scorer does not speak also scores zero and floors at
          -- low (ARCHITECTURE §9.5), and suppressing them would hide exactly
          -- the customer least able to chase us.
          --
          -- A conversation with NO assessment at all is not filtered here. It
          -- is scored below instead — see the note on the .filter().
          and not exists (
            select 1 from lead_assessments la
             where la.conversation_id = c.id
               and la.category = 'inbound_pitch'
          )`,
      [organizationId, String(WAITING_WARN_HOURS)]
    );

    return rows
      .filter((row) => {
        // SUPPRESSION KEYED ON A SIGNAL THAT MAY NEVER HAVE BEEN RECORDED.
        //
        // The clause above asks whether an `inbound_pitch` assessment exists.
        // For every conversation that predates lead scoring being wired into the
        // pipeline, none does — and "no assessment" then reads as "not a pitch".
        //
        // That is how this operator's only open urgent finding on production
        // came to be a data broker: *"Latest Owner, buyer and investor data
        // available… Do you need a database?"*, reported as a customer ignored
        // for 260.8 hours. The suppression was correct and simply had nothing
        // to act on, which is the same shape as every other defect in §8 — the
        // absence of a record reading as a negative answer.
        //
        // So when there is no assessment, ask the scorer directly. It is pure
        // and rules-based, costs no model call, and gives the same verdict it
        // would have given at the time. Scored on the LAST inbound message
        // because that is the one that has gone unanswered — a pitch that
        // opened with "hello" is still a pitch by the message it ends on.
        //
        // Conversations that DO have an assessment are left to the SQL: a
        // stored classification beats one recomputed from a single message.
        if (row.has_assessment || !row.last_body) return true;
        return scoreLead({ text: row.last_body }).category !== "inbound_pitch";
      })
      .map((row) => {
      const hours = Number(row.waited_hours);
      const who = row.contact_name ?? `+${row.wa_id}`;
      return {
        fingerprint: row.conversation_id,
        severity: hours >= WAITING_URGENT_HOURS ? "urgent" : "warn",
        title: `${who} has been waiting ${hours} hours for a reply`,
        detail: row.is_human_handoff
          ? "The AI is paused on this conversation because it was handed to a person. Nobody has replied since."
          : "The AI was not paused, so it should have answered. Check the reply pipeline for this conversation.",
        subjectKind: "conversation",
        subjectId: row.conversation_id,
      } satisfies FindingInput;
    });
  },
};

/**
 * A promise past its date.
 *
 * The follow-ups feature records what was agreed and shows it on a page. This
 * is what turns that from a list into something that comes and finds you.
 */
const overdueFollowUp: Operator = {
  slug: "overdue-followup",
  title: "Overdue follow-up",
  description: "Something was promised to a customer by a date that has passed.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      id: string;
      title: string;
      due_at: string;
      days_late: string;
      owner: string | null;
      contact_name: string | null;
    }>(
      `select t.id, t.title, t.due_at,
              round(extract(epoch from (now() - t.due_at)) / 86400.0, 1)::text as days_late,
              e.full_name as owner,
              ct.display_name as contact_name
         from tasks t
         left join employees e  on e.id = t.employee_id
         left join contacts  ct on ct.id = t.contact_id
        where t.organization_id = $1
          and t.status = 'open'
          and t.due_at is not null
          and t.due_at < now()`,
      [organizationId]
    );

    return rows.map((row) => {
      const late = Number(row.days_late);
      return {
        fingerprint: row.id,
        // A day late is a slip; a week late is a customer who has concluded
        // nobody is coming.
        severity: late >= 7 ? "urgent" : "warn",
        title: row.title,
        detail:
          `${late < 1 ? "Due earlier today" : `${plural(Math.floor(late), "day")} overdue`}` +
          `${row.contact_name ? ` · promised to ${row.contact_name}` : ""}` +
          `${row.owner ? ` · ${row.owner}` : " · nobody has been given this"}`,
        subjectKind: "task",
        subjectId: row.id,
      } satisfies FindingInput;
    });
  },
};

/**
 * Open work with nobody's name on it.
 *
 * SILENT FOR A BUSINESS WITH NO STAFF, and that is the point. Every follow-up
 * on this platform today is unassigned, because zero employees exist — so
 * without this guard the operator would report every single one, forever, with
 * no action available to anyone. A finding that cannot be acted on trains
 * people to skim past findings that can.
 */
const unownedFollowUp: Operator = {
  slug: "unowned-followup",
  title: "Nobody's job",
  description:
    "An open follow-up with no owner. Only reported for businesses that actually have staff to assign it to.",
  run: async (organizationId) => {
    const { rows: staff } = await getPool().query<{ n: string }>(
      `select count(*)::text as n from employees
        where organization_id = $1 and is_active = true`,
      [organizationId]
    );
    if (Number(staff[0]?.n ?? 0) === 0) return [];

    const { rows } = await getPool().query<{ id: string; title: string; age_days: string }>(
      `select id, title,
              round(extract(epoch from (now() - created_at)) / 86400.0, 1)::text as age_days
         from tasks
        where organization_id = $1 and status = 'open' and employee_id is null`,
      [organizationId]
    );

    return rows.map((row) => ({
      fingerprint: row.id,
      severity: "warn" as const,
      title: row.title,
      detail: `Unassigned for ${plural(Math.max(1, Math.floor(Number(row.age_days))), "day")}. Nobody has agreed to do this.`,
      subjectKind: "task",
      subjectId: row.id,
    }));
  },
};

/**
 * Knowledge the agent cannot answer from.
 *
 * A failed source is silent by nature: the agent keeps replying, just without
 * whatever that page said. The customer gets a confident answer built on less
 * than it should have been, which is the shape of failure this whole document
 * is about.
 */
const brokenKnowledge: Operator = {
  slug: "broken-knowledge",
  title: "Knowledge source failing",
  description:
    "A source the agent answers from could not be indexed. Replies still go out — just without what it contained.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      id: string;
      title: string;
      uri: string | null;
      error: string | null;
      status: string;
    }>(
      `select id, title, uri, error, status
         from knowledge_sources
        where organization_id = $1 and status = 'failed'`,
      [organizationId]
    );

    return rows.map((row) => ({
      fingerprint: row.id,
      severity: "warn" as const,
      title: `Cannot index "${row.title}"`,
      detail:
        (row.error ? `${row.error.slice(0, 200)}` : "No error recorded.") +
        (row.uri ? ` · ${row.uri}` : ""),
      subjectKind: "knowledge_source",
      subjectId: row.id,
    }));
  },
};

/**
 * An agent with almost nothing to answer from.
 *
 * ABR sat at FIVE indexed passages while nine pages of practice-area content —
 * roughly a thousand words each — sat one link from its home page. Nothing
 * reported it. `broken-knowledge` watches sources that FAIL, and there is a
 * blind spot next to it: a source that succeeded, and a business that simply
 * has too few. The system was content because nothing had gone wrong.
 *
 * It was found by counting rows by hand. That is the argument for this operator
 * — not the five passages, which are now fixed, but that finding them required
 * somebody to go looking. Tenant #6 onboarded with the ingestion step skipped
 * produces an agent that answers every question from nothing, deployed and
 * live, with every check green.
 *
 * WHAT THIS DOES NOT CLAIM. Chunk count is not answer quality. A hundred
 * passages of marketing copy answer less than twenty of real FAQ, and no
 * threshold here can tell the difference. It is a floor, not a grade: below it
 * the agent certainly cannot cover its own business, above it nothing is
 * asserted. The thresholds are deliberately far below anything arguable, so a
 * finding is never a matter of taste.
 */
export const THIN_KNOWLEDGE_CHUNKS = 15;

/**
 * The decision, separated from the query that feeds it.
 *
 * Not a tidiness refactor. Every business on this deployment is above the
 * threshold, so the branch that actually PRODUCES a finding has never run and
 * cannot be exercised without writing to production. Left inside `run` its only
 * evidence would be a test asserting that the source text contains the word
 * "urgent" — which is precisely the kind of test §8 exists to warn about: it
 * cannot tell whether the code works, only that somebody typed the right words
 * near it.
 *
 * Pure and exported, it can be called with the numbers that matter — including
 * the ones no tenant has today, and the ones either side of the boundary.
 */
export function assessKnowledgeVolume(
  organizationId: string,
  sources: number,
  chunks: number
): FindingInput[] {
  if (chunks >= THIN_KNOWLEDGE_CHUNKS) return [];

  return [
    {
      // One finding per business, not per missing page — there is one thing to
      // do about it, and a constant fingerprint means re-running reconciles
      // onto the same row rather than accumulating.
      fingerprint: "knowledge-volume",
      // Nothing at all is a different problem from not enough: the first is
      // almost always a skipped onboarding step, the second a thin website.
      severity: chunks === 0 ? "urgent" : "warn",
      title:
        chunks === 0
          ? "This agent has no knowledge at all"
          : `This agent knows only ${plural(chunks, "passage")}`,
      detail:
        chunks === 0
          ? "Every reply is generated with nothing to draw on. If this business is reachable by customers, it is answering them from nothing."
          : `${plural(sources, "source")} indexed. Below roughly ${THIN_KNOWLEDGE_CHUNKS} passages an agent cannot cover its own services, so it answers vaguely and escalates often — which reads as the agent being poor rather than under-supplied.`,
      subjectKind: "organization",
      subjectId: organizationId,
    },
  ];
}

const thinKnowledge: Operator = {
  slug: "thin-knowledge",
  title: "Agent has almost nothing to answer from",
  description:
    "This business's agent is answering customers from very little indexed content. Replies will be vague and escalate often, and nothing else reports it because no source has failed.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      sources: string;
      chunks: string;
    }>(
      `select count(distinct s.id)::text as sources,
              count(k.id)::text          as chunks
         from knowledge_sources s
         left join knowledge_chunks k on k.source_id = s.id
        where s.organization_id = $1
          and s.status <> 'failed'`,
      [organizationId]
    );

    return assessKnowledgeVolume(
      organizationId,
      Number(rows[0]?.sources ?? 0),
      Number(rows[0]?.chunks ?? 0)
    );
  },
};

/**
 * Governance is not actually judging anything.
 *
 * FOUND IN PRODUCTION 2026-08-13, by generating one reply per business and
 * reading the verdict beside it. The Anthropic key has no credit, so every
 * judge call throws and `evaluateHallucinationRisk` returns "medium". That
 * value is not a verdict; it is the absence of one, and nothing downstream can
 * tell the difference:
 *
 *   juris-prime, juris-prime-legal, abr — not on the medium-tolerant allowlist,
 *     so `shouldEscalateReply` returns true for EVERY reply. Three businesses
 *     escalating everything they generate, and with an empty rota that means
 *     the customer gets the no-staff fallback instead of the good, grounded
 *     answer the agent actually wrote.
 *
 *   zipicka, sfs-international — tolerant of medium, so every reply goes out
 *     having been checked by nothing at all.
 *
 * Neither state raises an error. The deck shows "hallucination risk medium",
 * which reads exactly like a judge that ran.
 *
 * This operator calls no model, which is the property that matters: it has to
 * work on the day the models are the thing that is broken. It counts recent
 * evaluations whose notes carry the marker the judge writes when it cannot be
 * reached.
 */
const JUDGE_LOOKBACK_HOURS = 24;

const judgeOffline: Operator = {
  slug: "judge-offline",
  title: "Governance is not checking replies",
  description:
    "The hallucination judge could not be reached, so every reply is being recorded as medium risk without being examined. Strict businesses escalate everything; tolerant ones send everything unchecked.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{ failed: string; total: string }>(
      `select count(*) filter (where notes like $2 || '%')::text as failed,
              count(*)::text                                     as total
         from ai_message_evaluations
        where organization_id = $1
          and created_at > now() - ($3 || ' hours')::interval`,
      [organizationId, JUDGE_UNAVAILABLE, String(JUDGE_LOOKBACK_HOURS)]
    );

    const failed = Number(rows[0]?.failed ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    if (failed === 0) return [];

    // Urgent whenever it is happening at all. A judge that fails intermittently
    // is not a degraded judge — it is one whose verdicts you cannot trust,
    // because a "medium" from a working call and a "medium" from a failed one
    // are the same row.
    return [
      {
        fingerprint: "judge-unavailable",
        severity: "urgent" as const,
        title: `Governance did not examine ${plural(failed, "reply", "replies")}`,
        detail: `${failed} of ${total} evaluations in the last ${JUDGE_LOOKBACK_HOURS} hours recorded the judge as unreachable, and each was stored as "medium" risk without being read. Usually a model API key that is out of credit or over quota.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

export const OPERATORS: Operator[] = [
  customerWaiting,
  overdueFollowUp,
  unownedFollowUp,
  brokenKnowledge,
  thinKnowledge,
  judgeOffline,
];

export interface OperatorRunSummary {
  operator: string;
  organizationSlug: string;
  standing: number;
  retracted: number;
  failed?: string;
}

/**
 * One pass of every operator over every business.
 *
 * Each operator runs inside its own business's tenant context — they read
 * customer data, and doing that cross-tenant would be the widest read on the
 * platform performed by code nobody is watching.
 *
 * ONE OPERATOR'S FAILURE MUST NOT SILENCE THE OTHERS. They are independent
 * checks; a broken query in one is not evidence about the rest. Failures are
 * logged and reported in the summary rather than thrown — but note what is NOT
 * done on failure: the operator's existing findings are left exactly as they
 * are. Retracting them because the check could not run would quietly clear real
 * problems off an operator's screen on the strength of an error.
 */
export async function runOperators(): Promise<OperatorRunSummary[]> {
  const organizations = await listOrganizations();
  const summaries: OperatorRunSummary[] = [];

  for (const organization of organizations) {
    for (const operator of OPERATORS) {
      try {
        const summary = await withTenant(organization.id, async () => {
          const found = await operator.run(organization.id);
          const result = await reconcileFindings(organization.id, operator.slug, found);
          return result;
        });
        summaries.push({
          operator: operator.slug,
          organizationSlug: organization.slug,
          standing: summary.standing,
          retracted: summary.retracted,
        });
      } catch (err) {
        logger.error(
          { operator: operator.slug, organization: organization.slug, err },
          "Operator failed — its existing findings are left untouched"
        );
        summaries.push({
          operator: operator.slug,
          organizationSlug: organization.slug,
          standing: 0,
          retracted: 0,
          failed: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return summaries;
}
