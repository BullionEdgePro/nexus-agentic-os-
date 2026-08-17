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
          -- evaluated_at, not created_at. This table has no created_at, and the
          -- guess cost a failed operator sweep across all five businesses.
          and evaluated_at > now() - ($3 || ' hours')::interval`,
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

// A proposal nobody looks at is the same as no proposal.
//
// F10 deliberately never activates anything it infers: a procedure goes into
// the prompt for every future customer of that business, so a person decides.
// That restraint is correct, and it creates exactly one failure mode — the
// inference runs nightly, proposals accumulate on a screen nobody opens, and
// the feature reports itself as working while changing nothing.
//
// Nothing else would show it. There is no error, the queue succeeds, the rows
// are written. The only symptom is a screen with a number on it that no one
// has seen. That is the shape this platform keeps producing, so it gets an
// operator like every other one.
const PROCEDURE_REVIEW_DAYS = 7;

const procedureAwaitingReview: Operator = {
  slug: "procedure-awaiting-review",
  title: "Suggested answers are waiting for a decision",
  description:
    "The platform noticed how this business answers a recurring question and wrote it down, but nobody has accepted or dismissed it. Until someone does, it changes nothing.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{ waiting: string; oldest_days: string }>(
      `select count(*)::text                                                as waiting,
              coalesce(max(extract(day from now() - created_at)), 0)::text  as oldest_days
         from procedures
        where organization_id = $1
          and source = 'inferred'
          and is_active = false
          -- A dismissed suggestion is a decision that was made, not one that is
          -- outstanding. Only rows nobody has ruled on count as waiting.
          --
          -- Both columns are checked on purpose. reviewed_at and dismissed_at
          -- are separate columns, and relying on the UI to stamp both
          -- would make this operator's correctness depend on a detail of a
          -- screen it never sees: dismiss a suggestion, and it would keep
          -- appearing here as outstanding work.
          and reviewed_at is null
          and dismissed_at is null`,
      [organizationId]
    );

    const waiting = Number(rows[0]?.waiting ?? 0);
    if (waiting === 0) return [];

    const oldestDays = Number(rows[0]?.oldest_days ?? 0);

    // Never urgent. Nothing is broken and no customer is affected — an
    // unreviewed suggestion simply does not apply. Raising this to urgent would
    // teach people that urgent means "someone has admin to catch up on", which
    // is how the genuinely urgent findings stop being read.
    return [
      {
        fingerprint: "procedures-awaiting-review",
        severity: "warn" as const,
        title: `${plural(waiting, "suggested answer")} waiting to be reviewed`,
        detail:
          oldestDays >= PROCEDURE_REVIEW_DAYS
            ? `${waiting} waiting, the oldest for ${plural(Math.floor(oldestDays), "day")}. Accepting one makes the agent follow that order of questions; dismissing it stops the platform proposing it again until the evidence doubles.`
            : `${waiting} waiting on the "How we answer" screen. Each was drawn from at least five conversations that ended without a human.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

// An appointment tomorrow that belongs to nobody.
//
// The agent can now book for real, and a booking with no employee on it is the
// one failure in this platform a customer experiences physically: they travel
// somewhere and nobody is expecting them. The database prevents two bookings in
// one slot; nothing prevents a slot belonging to no one.
//
// Deliberately only looks forward. A past unassigned booking is a record to
// tidy; a future one is somebody's morning.
const BOOKING_LOOKAHEAD_HOURS = 48;

const bookingUnassigned: Operator = {
  slug: "booking-unassigned",
  title: "An appointment with nobody assigned",
  description:
    "A confirmed appointment is coming up and no member of staff is attached to it. The customer will arrive expecting someone.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      id: string;
      starts_at: string;
      hours_away: string;
      subject: string | null;
    }>(
      `select b.id,
              to_char(b.starts_at, 'Dy DD Mon HH24:MI')                            as starts_at,
              round(extract(epoch from (b.starts_at - now())) / 3600.0, 1)::text   as hours_away,
              b.subject
         from bookings b
        where b.organization_id = $1
          and b.status = 'confirmed'
          and b.employee_id is null
          and b.starts_at > now()
          and b.starts_at < now() + ($2 || ' hours')::interval
        order by b.starts_at`,
      [organizationId, String(BOOKING_LOOKAHEAD_HOURS)]
    );

    // Keyed per booking, not per business: two unassigned appointments are two
    // people to disappoint, and assigning one should retract only its own row.
    return rows.map((row) => ({
      fingerprint: `booking-unassigned:${row.id}`,
      // Inside a working day it is urgent; beyond that there is time to roster.
      severity: Number(row.hours_away) <= 12 ? ("urgent" as const) : ("warn" as const),
      title: `${row.subject ?? "Appointment"} on ${row.starts_at} has nobody assigned`,
      detail: `Confirmed, ${Math.round(Number(row.hours_away))} hours away, no member of staff attached. Assign someone or cancel it — a customer who arrives to an empty desk is the one mistake here that cannot be undone by a message.`,
      subjectKind: "booking",
      subjectId: row.id,
    }));
  },
};

// A template Meta has stopped accepting.
//
// Campaigns keep drafting against it perfectly well; the refusal only arrives at
// send, in front of a customer, on the one path where the business speaks first.
// `syncAllTemplates()` already writes the status down every time it runs, and
// until now nothing read it.
const templateRejected: Operator = {
  slug: "template-rejected",
  title: "A message template is no longer approved",
  description:
    "Meta has rejected or paused a template. Campaigns can still be drafted with it, and will fail when they are sent.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{ names: string; n: string }>(
      `select string_agg(meta_template_name, ', ' order by meta_template_name) as names,
              count(*)::text                                                   as n
         from message_templates
        where organization_id = $1
          -- Read from the status Meta reported, not from is_approved: the two
          -- are written by the same sync, and a template can be paused without
          -- ever having been un-approved.
          and status is not null
          and lower(status) not in ('approved', 'active')`,
      [organizationId]
    );

    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) return [];

    return [
      {
        fingerprint: "template-not-approved",
        severity: "warn" as const,
        title: `${plural(n, "template")} not approved by Meta`,
        detail: `${rows[0]?.names}. A campaign built on one of these drafts normally and fails at send. Fix the wording in WhatsApp Manager and resubmit, or stop using it.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

// Somebody who spoke to this business once and has not been back.
//
// Reported rather than acted on, deliberately. The sender does not exist yet,
// and this is the half worth having first: it makes the opportunity visible
// while a person still decides whether reaching out is appropriate. Reversing
// that order is how a platform starts messaging people on its own.
const QUIET_DAYS = 30;

const reengagementCandidate: Operator = {
  slug: "reengagement-candidate",
  title: "Customers who went quiet",
  description:
    "People who talked to this business and have not been back. Nothing is sent automatically — this is a list to decide about.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n
         from contacts ct
        where ct.organization_id = $1
          and ct.reengagement_opted_out = false
          -- Quiet is measured on MESSAGES, not on the conversation row.
          --
          -- The first version read conversations.updated_at, which does not
          -- exist — the table keeps opened_at and closed_at. It threw for all
          -- five businesses on the first sweep, which is the correct outcome
          -- for a column that was assumed rather than read.
          --
          -- Messages are the better signal regardless: a conversation left open
          -- is not a customer still talking, and a closed one they wrote to
          -- yesterday is not a customer who went quiet.
          and exists (
            select 1
              from messages m
              join conversations c on c.id = m.conversation_id
             where c.contact_id = ct.id
          )
          and not exists (
            select 1
              from messages m
              join conversations c on c.id = m.conversation_id
             where c.contact_id = ct.id
               and m.created_at >= now() - ($2 || ' days')::interval
          )
          -- Not already inside a cooldown from a previous attempt.
          and not exists (
            select 1 from reengagement_attempts ra
             where ra.contact_id = ct.id
               and ra.cooldown_until > now()
          )`,
      [organizationId, String(QUIET_DAYS)]
    );

    const n = Number(rows[0]?.n ?? 0);
    // Below a handful this is not a list, it is a coincidence.
    if (n < 3) return [];

    return [
      {
        fingerprint: "reengagement-candidates",
        severity: "warn" as const,
        title: `${plural(n, "customer")} have not been back in ${QUIET_DAYS} days`,
        detail: `${n} people spoke to this business and went quiet, none of them opted out or inside a cooldown. Reaching out uses an approved template and counts as a paid conversation — worth a decision, not an automation.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

// Retrieval is down, and every reply still looks fine.
//
// On 15 August 2026 Google's embedding endpoint returned 503 for an extended
// period. The reply path handled it exactly right: the tool caught the error,
// the agent kept answering, said it could not confirm the detail, and
// governance still applied. Nothing was fabricated and nothing crashed.
//
// Nobody would have known. A customer being told "a colleague can confirm this"
// because the provider is down reads identically to being told it because the
// business genuinely has nothing on file. Over a week, every customer would be
// politely deflected and the only symptom would be a quiet fall in usefulness.
//
// This is the operator that outage argued for. It exists because migration 038
// finally writes the distinction down — before that there was nothing to sweep.
const RETRIEVAL_LOOKBACK_HOURS = 6;

const retrievalUnavailable: Operator = {
  slug: "retrieval-unavailable",
  title: "The agent cannot read the knowledge base",
  description:
    "Knowledge lookups are failing, so replies are going out ungrounded. Customers are being told a colleague will confirm — which sounds like a business with no answer rather than a provider that is down.",
  // MIGRATION 047 ADDED A WAY FOR THIS OPERATOR TO GO BLIND, so it sweeps for
  // two values now. The lexical fallback answers from Postgres when the
  // embedding provider is unreachable, and it records itself as 'degraded'
  // rather than 'failed' — which is correct, and which would have quietly
  // emptied the predicate this operator was built on. A mitigation that
  // switches off the alarm it was written for leaves the platform worse than
  // before: the outage would go on being real and stop being visible.
  //
  // Both values mean the same upstream fact — semantic search did not run. What
  // differs is what it cost the customer, and that is what sets severity rather
  // than what raises the finding.
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      failed: string;
      degraded: string;
      attempted: string;
    }>(
      `select count(*) filter (where retrieval_outcome = 'failed')::text as failed,
              count(*) filter (where retrieval_outcome = 'degraded')::text as degraded,
              count(*) filter (where retrieval_outcome is not null)::text as attempted
         from conversation_metrics
        where organization_id = $1
          and recorded_at > now() - ($2 || ' hours')::interval`,
      [organizationId, String(RETRIEVAL_LOOKBACK_HOURS)]
    );

    const failed = Number(rows[0]?.failed ?? 0);
    const degraded = Number(rows[0]?.degraded ?? 0);
    const attempted = Number(rows[0]?.attempted ?? 0);
    const unhealthy = failed + degraded;
    if (unhealthy === 0) return [];

    // Urgent as soon as anyone was deflected, like judge-offline and for the
    // same reason: a lookup that fails intermittently is not degraded
    // retrieval, it is retrieval you cannot tell apart from an empty shelf.
    //
    // Degraded-only stays a warning and is still raised. The customers were
    // answered, so nobody is being turned away this minute — but they were
    // answered from keyword matches that nobody has read, on a provider that is
    // down and will not fix itself, and "it is coping" is the state most likely
    // to be left running for a week.
    const deflected = failed > 0;
    return [
      {
        fingerprint: "retrieval-unavailable",
        severity: deflected ? ("urgent" as const) : ("warn" as const),
        title: deflected
          ? `${failed} of ${attempted} knowledge lookups failed`
          : `${degraded} of ${attempted} replies answered on keyword search`,
        detail: deflected
          ? `In the last ${RETRIEVAL_LOOKBACK_HOURS} hours, ${failed} lookups could not run and found nothing to answer from — usually the embedding provider being unreachable, out of quota, or a missing key. Those replies went out ungrounded, telling customers a colleague would confirm.${degraded > 0 ? ` A further ${degraded} were answered by the keyword fallback instead.` : ""} Check egress to the embedding endpoint before assuming the index is at fault.`
          : `In the last ${RETRIEVAL_LOOKBACK_HOURS} hours, semantic search could not run ${degraded} times and Postgres keyword matching answered instead. Customers were not deflected, which is why this is a warning and not an alarm — but keyword matching finds the right page roughly 13 times in 18 where the real ranker finds it 18, so some of those replies are built on a page that merely shares a word with the question. Check egress to the embedding endpoint, then read those conversations.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

/**
 * The classifier stopped, and F5 went quiet in the way it always looks quiet.
 *
 * `IntentCoverage.neverClassified` carries this warning in its own doc comment:
 * it "counts conversations whose metrics carry a NULL intent, which nothing in
 * the reply path writes any more — so it should only ever be historical rows.
 * Rising, it means the classifier stopped running, and that is a defect rather
 * than a quiet week."
 *
 * Nothing watched it. `getIntentCoverage` is read by `backfill-intent.ts` and
 * by nothing else, so the number was only ever consulted by a person running a
 * script by hand — which is to say, after somebody already suspected a problem.
 *
 * WHY THIS IS THE OPERATOR F5 MOST NEEDED. Everything downstream of intent
 * degrades to a plausible empty result when classification stops. The shared
 * store pools nothing and reports "not enough tenants yet". Procedure recall
 * finds no procedure, which is what "this business has none" looks like. The
 * hotspots list empties. Every one of those reads as a quiet week, and this
 * feature has already lost its whole first life to exactly that confusion:
 * intent came from tool calls alone, 83% of traffic fires no tool, and the
 * store spent months reading a sixth of the platform while looking merely new.
 *
 * Per business rather than platform-wide, because that is the shape every
 * operator has and because a classifier failing for one tenant is a real state —
 * the reply path is the same code, but traffic is not.
 *
 * Calls no model, like every operator here, which is the property that matters
 * on the day the models are the thing that broke.
 */
const INTENT_LOOKBACK_HOURS = 24;

const intentClassificationStopped: Operator = {
  slug: "intent-unclassified",
  title: "Conversations are being recorded with no intent",
  description:
    "Something wrote a metric row without an intent, which nothing in the reply path does any more. Downstream this looks like a quiet week: the shared brain pools nothing, procedures are never recalled, and hotspots empty — all of it indistinguishable from having no traffic.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{ missing: string; total: string }>(
      `select count(*) filter (where intent is null)::text  as missing,
              count(*)::text                                as total
         from conversation_metrics
        where organization_id = $1
          and recorded_at > now() - ($2 || ' hours')::interval`,
      [organizationId, String(INTENT_LOOKBACK_HOURS)]
    );

    const missing = Number(rows[0]?.missing ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    if (missing === 0) return [];

    return [
      {
        fingerprint: "intent-unclassified",
        severity: "urgent" as const,
        title: `${missing} of ${total} conversations recorded without an intent`,
        detail: `In the last ${INTENT_LOOKBACK_HOURS} hours, ${missing} metric rows carry a NULL intent. The reply path always calls the classifier, so this is not a quiet week — it means classification did not run. Everything keyed on intent degrades silently while it lasts: the shared brain pools nothing, no procedure is ever recalled, and escalation hotspots empty. Check the reply pipeline before reading any of those as "not enough traffic yet".`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

/**
 * A handover nobody ever came to, which no operator could see.
 *
 * FOUND IN PRODUCTION 2026-08-17 by reading `is_human_handoff` directly rather
 * than trusting the finding list. Four Zipicka conversations opened 1–3 August
 * are still paused, still open, and have never had a human message in them.
 * Sixteen days. Two of them are people who said "Hi", were told a specialist
 * would follow up, and heard nothing.
 *
 * ARCHITECTURE §9.5 records this state and says the promise was fixed. It was:
 * escalation no longer promises staff who do not exist. What was never fixed is
 * the conversations already in it — and, more importantly, nothing watches for
 * new ones.
 *
 * WHY `customer-waiting` CANNOT SEE IT, which is the whole reason this exists.
 * That operator requires `last.sender_type = 'contact'` — the customer must
 * have spoken last, which is what makes it "waiting" rather than "quiet". But
 * this state is created BY THE AGENT SPEAKING: it sends "I'm looping in a
 * specialist", sets `is_human_handoff`, and stops. The last message is
 * therefore outbound, forever, and the operator goes quiet.
 *
 * It did more than go quiet. It had raised "khan has been waiting 261 hours for
 * a reply" on 2026-08-12 and then RETRACTED it — the finding reads resolved in
 * `operator_findings` today while the customer has still never been answered.
 * Retraction is correct behaviour for that operator's own question and produced
 * exactly the wrong impression: a promise was made, the agent was switched off,
 * and the alert cleared itself.
 *
 * THE TEST HERE IS "DID A HUMAN EVER ARRIVE", not "how long since a message".
 * A conversation where somebody replied and the customer went away happy also
 * has an outbound last message and an old timestamp. The distinguishing fact is
 * that no `human_agent` message exists in it at all, which is precisely what
 * was promised and never delivered.
 *
 * Calls no model, like every operator here.
 */
const ABANDONED_HANDOVER_HOURS = 12;

const handoverAbandoned: Operator = {
  slug: "handover-abandoned",
  title: "A handover nobody came to",
  description:
    "The agent promised a colleague and paused itself, and no colleague has ever replied. The customer was told help was coming and then heard nothing, and because the agent spoke last this looks like an answered conversation to every other check.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      conversation_id: string;
      contact_name: string | null;
      wa_id: string;
      paused_hours: string;
      last_body: string | null;
      has_assessment: boolean;
    }>(
      `select c.id as conversation_id,
              ct.display_name as contact_name,
              ct.wa_id,
              round(extract(epoch from (now() - last.created_at)) / 3600.0, 1)::text as paused_hours,
              last_in.body as last_body,
              exists (
                select 1 from lead_assessments la where la.conversation_id = c.id
              ) as has_assessment
         from conversations c
         join contacts ct on ct.id = c.contact_id
         join lateral (
           select created_at from messages m
            where m.conversation_id = c.id
            order by m.created_at desc limit 1
         ) last on true
         -- The customer's own last words, for the pitch check below. Separate
         -- from the lateral above because by definition the agent spoke last
         -- here. (No backticks in this comment: it lives inside a template
         -- literal, and one would end the string.)
         left join lateral (
           select body from messages m
            where m.conversation_id = c.id and m.sender_type = 'contact'
            order by m.created_at desc limit 1
         ) last_in on true
        where c.organization_id = $1
          and c.status in ('open', 'pending')
          -- The agent is switched off for this conversation.
          and c.is_human_handoff
          -- And nobody ever arrived. This is the clause that separates an
          -- abandoned promise from a handover that was honoured.
          and not exists (
            select 1 from messages m
             where m.conversation_id = c.id and m.sender_type = 'human_agent'
          )
          and last.created_at < now() - ($2 || ' hours')::interval
          -- Same suppression as customer-waiting, for the same reason: two of
          -- the four found in production are cold pitches, and reporting a data
          -- broker as an abandoned customer is the noise that teaches an
          -- operator to stop reading the list.
          and not exists (
            select 1 from lead_assessments la
             where la.conversation_id = c.id and la.category = 'inbound_pitch'
          )`,
      [organizationId, String(ABANDONED_HANDOVER_HOURS)]
    );

    return rows
      .filter((row) => {
        // And the same fallback, for the same reason: conversations predating
        // lead scoring carry no assessment, and "no assessment" must not read
        // as "not a pitch". Scored on the customer's last message, which is the
        // one the promise was made about.
        if (row.has_assessment || !row.last_body) return true;
        return scoreLead({ text: row.last_body }).category !== "inbound_pitch";
      })
      .map((row) => {
        const hours = Number(row.paused_hours);
        const who = row.contact_name ?? `+${row.wa_id}`;
        const days = Math.floor(hours / 24);
        return {
          fingerprint: row.conversation_id,
          // Always urgent. There is no gentle version of a customer who was
          // promised a person and then cut off from the only thing answering
          // them — and unlike a slow reply, this state does not resolve itself.
          severity: "urgent" as const,
          title: `${who} was promised a colleague ${days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${hours} hours`} ago and nobody came`,
          detail: `The agent handed this conversation to a person and paused itself ${hours} hours ago. No colleague has ever replied in it, so the customer has heard nothing since being told help was coming — and because the agent spoke last, every other check reads this as answered. Either reply to them, or take the conversation off handover so the agent starts answering again.`,
          subjectKind: "conversation",
          subjectId: row.conversation_id,
        } satisfies FindingInput;
      });
  },
};

export const OPERATORS: Operator[] = [
  customerWaiting,
  handoverAbandoned,
  retrievalUnavailable,
  intentClassificationStopped,
  overdueFollowUp,
  unownedFollowUp,
  brokenKnowledge,
  thinKnowledge,
  judgeOffline,
  procedureAwaitingReview,
  bookingUnassigned,
  templateRejected,
  reengagementCandidate,
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
