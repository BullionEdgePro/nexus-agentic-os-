import {
  getPool,
  listOrganizations,
  findOrganizationById,
  reconcileFindings,
  listJobHeartbeats,
  countKnowledgeSourcesAcrossPlatform,
  withTenant,
  withAllTenants,
  type FindingInput,
  type RaisedFinding,
  AUTO_REVIEWER,
} from "@nexus/db";
// Pure and rules-based — no model call, so using it here keeps operators within
// the property that makes them cheap enough to run every ten minutes.
import { scoreLead } from "@nexus/leads";
import { JUDGE_UNAVAILABLE } from "@nexus/governance";
import {
  isJobStalled,
  hasJobFailedRecently,
  knowledgeRefreshBoundHours,
  knowledgeRefreshCapacityPerDay,
  JOB_STALE_AFTER_SECONDS,
  type ScheduledJob,
} from "@nexus/shared";
import { readAccountStanding, type AccountStanding } from "../lib/whatsapp-client.js";
import { logger } from "../lib/logger.js";
import { runAutomations } from "./automation-runner.js";
import { dispatchRaisedFindings } from "./alert-dispatch.js";

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

/**
 * What the sweep knows before it enters any business's transaction.
 *
 * ============================================================
 * WHY THIS IS A PARAMETER AND NOT A FUNCTION CALL
 * ============================================================
 *
 * The colleague rule needs every business's staff numbers. Reading them inside
 * an operator does not work, and it fails in the quietest possible way.
 *
 * Measured on production 2026-08-27, the same read from two places:
 *
 *   at top level:               6 staff numbers
 *   inside withTenant(zipicka): 1 staff number   <- Atif invisible
 *
 * `withClient` reuses an already-open transaction, so `withAllTenants` nested
 * inside `withTenant` runs on the OUTER connection with `app.current_org` still
 * set -- and `employees` is tenant-scoped, so RLS returns only that business's
 * own staff. No error, a plausible-looking Set, and a colleague from another
 * business silently absent from it.
 *
 * This codebase already documented the same shape one level down, in
 * `withServingTenant`: "`withTenant` nested inside `withTenant` deliberately
 * reuses the outer context rather than opening a second one -- so
 * `withTenant(serving.id, ...)` at those call sites was a no-op that READ
 * EXACTLY LIKE A FIX." I wrote a warning about that trap into the colleague
 * rule and then walked into it one level up, in the same commit.
 *
 * So it is computed once per sweep, before the per-business loop, and handed
 * down. A parameter cannot be forgotten the way a call can be got wrong.
 */
export interface SweepContext {
  /** Every active employee's WhatsApp number, across all businesses. */
  staffNumbers: Set<string>;
  /**
   * How Meta rates the shared number, read ONCE for the whole sweep.
   *
   * Not per business, deliberately. Every business here answers on the same
   * number, so asking Meta five times would be four network calls to learn the
   * same fact — and it would change what an operator IS. The rest are plain SQL
   * against an open transaction, cheap enough to run every ten minutes without
   * anybody thinking about it, and a per-business HTTP call quietly gives that
   * up. Fetched by the sweep, shared by everyone, `null` when Meta could not be
   * reached.
   */
  numberStanding: AccountStanding | null;
}

export interface Operator {
  slug: string;
  /** Shown on the page, so a reader knows what is watching them. */
  title: string;
  description: string;
  /**
   * Returns everything currently wrong for this business.
   *
   * `sweep` carries facts that must be read OUTSIDE any tenant transaction.
   * Passed in rather than fetched, because fetching them here cannot work: see
   * `SweepContext`.
   */
  run: (organizationId: string, sweep: SweepContext) => Promise<FindingInput[]>;
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
/**
 * WHICH OF FOUR THINGS HAPPENED, rather than which of two.
 *
 * ============================================================
 * WHAT THE OLD SENTENCE COST
 * ============================================================
 *
 * This finding used to branch on one boolean. If the AI was not paused it said
 * "it should have answered. Check the reply pipeline for this conversation."
 *
 * On 2026-08-20 that sentence was read literally and an afternoon went into
 * chasing a reply pipeline that was working perfectly. The truth was the third
 * case below: a colleague had answered the conversation on the 10th, the
 * customer wrote again on the 19th while the handoff flag was still set, the
 * agent correctly stayed silent, and the flag was cleared afterwards -- leaving
 * a conversation that looks, to one boolean, exactly like a broken pipeline.
 *
 * Measured on production the same day: three waiting conversations, three
 * DIFFERENT causes, one sentence between them.
 *
 * ============================================================
 * WHY THE ORDER OF THE BRANCHES IS THE DESIGN
 * ============================================================
 *
 * Each branch names a different person and a different next action, so the
 * order runs from the most specific evidence to the least:
 *
 *   paused now          somebody holds it. Chase them.
 *   a colleague spoke   somebody held it and stopped. Chase them, and know the
 *                       agent will take their NEXT message.
 *   an outcome recorded the agent decided, and said why. Read the reason.
 *   nothing recorded    nobody accounted for this message. THIS is the one that
 *                       means the platform, and it is now the only one that
 *                       says so.
 *
 * The last branch is deliberately the fallback rather than the default. Before,
 * "the platform is broken" was what you got whenever the flag was false, which
 * is most of the time -- so the alarming reading was also the commonest one,
 * and it stopped meaning anything. It now requires every other explanation to
 * have been ruled out, which is what makes it worth reading.
 *
 * SEVERITY IS UNCHANGED AND STAYS ON TIME ALONE. The cause decides who acts,
 * not how fast. Grading a platform fault higher would be defensible, but it
 * would also change what the dispatcher sends at 3am on a signal this operator
 * has only just started collecting.
 */
function whyNobodyAnswered(row: {
  is_human_handoff: boolean;
  a_human_spoke_before: boolean;
  recorded_outcome: string | null;
}): string {
  if (row.is_human_handoff) {
    return "The AI is paused on this conversation because it was handed to a person. Nobody has replied since.";
  }

  if (row.a_human_spoke_before) {
    return (
      "A colleague replied here earlier and the conversation has gone quiet since. The AI is no " +
      "longer paused, so it will answer this customer's NEXT message — but this one is waiting on " +
      "a person, not on the platform."
    );
  }

  if (row.recorded_outcome) {
    return `${describeOutcome(row.recorded_outcome)} This was a decision, not a failure — the reply path ran and recorded it.`;
  }

  return (
    "Nothing recorded an outcome for this message, so as far as the platform can tell it was never " +
    "answered and never deliberately skipped. This is the one to escalate: check the worker and the " +
    "webhook for this conversation."
  );
}

/** The recorded reply outcomes, in the words of somebody who has to act on one. */
function describeOutcome(outcome: string): string {
  switch (outcome) {
    case "skipped_handover":
      return "The agent stayed silent on purpose because the conversation was handed to a person at the time.";
    case "fallback":
      return "The agent could not answer and sent its fallback message instead.";
    case "none":
      return "The agent ran and decided to send nothing.";
    case "agent":
    case "agent_unrecorded":
      // Contradicts the operator's own premise -- it only selects conversations
      // whose last message is inbound. Say so rather than paper over it: a
      // reply recorded as sent with no outbound message is a delivery problem,
      // and is worth more attention than a customer simply waiting.
      return "The platform recorded a reply as sent, but no outbound message exists on this conversation. That is a delivery problem, not a slow colleague.";
    default:
      return `The reply path recorded "${outcome}" for this message.`;
  }
}

/**
 * Every conversation whose last word was the customer's, older than the warn
 * threshold -- optionally including the ones the pitch rule silences.
 *
 * Pulled out of the operator on 2026-08-25 so that the operator and the view
 * of what it SUPPRESSED read the same rows through the same predicate. Two
 * copies would be two things watching one table, and the day they drifted the
 * deck would report nothing suppressed while something was.
 */
export async function unansweredConversations(
  organizationId: string,
  includeSuppressed: boolean
) {
  const { rows } = await getPool().query<{
    conversation_id: string;
    serving_organization_id: string;
    contact_name: string | null;
    wa_id: string;
    waited_hours: string;
    is_human_handoff: boolean;
    last_body: string | null;
    has_assessment: boolean;
    is_pitch: boolean;
    a_human_spoke_before: boolean;
    recorded_outcome: string | null;
  }>(
    `select c.id as conversation_id,
            -- WHO THIS CUSTOMER IS ACTUALLY WAITING ON. All five businesses
            -- answer on one number, so a routed conversation is owned by the
            -- number's owner and this operator can only see it from the
            -- owner's transaction. Two findings on production named Zipicka
            -- for customers of SFS International and Juris Prime; the second
            -- of those IS the seventeen-hour silence. See migration 053.
            coalesce(c.routed_organization_id, c.organization_id) as serving_organization_id,
            ct.display_name as contact_name,
            ct.wa_id,
            round(extract(epoch from (now() - last.created_at)) / 3600.0, 1)::text as waited_hours,
            c.is_human_handoff,
            last.body as last_body,
            exists (
              select 1 from lead_assessments la where la.conversation_id = c.id
            ) as has_assessment,
            -- Distinct from has_assessment: "scored at all" and "scored AS a
            -- pitch" are different facts, and only the second one silences.
            exists (
              select 1 from lead_assessments la
               where la.conversation_id = c.id and la.category = 'inbound_pitch'
            ) as is_pitch,
            -- DID A COLLEAGUE EVER SPEAK HERE?
            --
            -- handover-abandoned deliberately excludes any conversation where
            -- a human has spoken, because its subject is a promise nobody
            -- came to. That leaves the half-abandoned case -- a colleague
            -- answered once and then went quiet -- belonging to no operator
            -- at all, and arriving here with the handoff flag since cleared.
            exists (
              select 1 from messages m
               where m.conversation_id = c.id and m.sender_type = 'human_agent'
            ) as a_human_spoke_before,
            -- WHAT THE REPLY PATH SAID ABOUT *THIS* MESSAGE.
            --
            -- Bounded to outcomes recorded at or after the unanswered message
            -- arrived. Without that bound this picks up the outcome of a
            -- PREVIOUS exchange and reports it as the reason for this
            -- silence -- which is the same class of mistake as the sentence
            -- this whole change exists to remove, produced by a sloppier
            -- query. Null means nothing accounted for the message at all.
            (
              select cm.reply_outcome
                from conversation_metrics cm
               where cm.conversation_id = c.id
                 and cm.reply_outcome is not null
                 and cm.recorded_at >= last.created_at
               order by cm.recorded_at asc
               limit 1
            ) as recorded_outcome
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
        -- $3 KEEPS the pitches instead of dropping them, which is how the
        -- "not reported" view sees what this operator chose to silence.
        -- One query rather than two: a second copy of this predicate is
        -- two things watching one table, and the day they disagree the
        -- deck says nothing was suppressed while something was.
        and (
          $3::boolean
          or not exists (
            select 1 from lead_assessments la
             where la.conversation_id = c.id
               and la.category = 'inbound_pitch'
          )
        )`,
    [organizationId, String(WAITING_WARN_HOURS), includeSuppressed]
  );
  return rows;
}

/**
 * Does this look like somebody selling TO us rather than a customer?
 *
 * THE DECISION THAT SILENCES A CONVERSATION, named once and exported so the
 * screen showing what was silenced cannot disagree with the operator doing
 * the silencing.
 *
 * A stored classification beats one recomputed from a single message, so a
 * conversation that HAS an assessment is taken at its word. Where none was
 * ever recorded -- every conversation predating lead scoring being wired into
 * the pipeline -- the scorer is asked directly. It is pure, rules-based and
 * costs no model call, and it gives the verdict it would have given at the
 * time. Scored on the LAST inbound message, because that is the one that has
 * gone unanswered: a pitch that opened with "hello" is still a pitch by the
 * message it ends on.
 *
 * Worth stating plainly, because it is the sharpest edge in this file: this
 * decides which unanswered customers are NEVER reported, and it is made by a
 * rules scorer whose accuracy nothing measured until F3's labels existed. A
 * wrong "true" here is a real customer waiting for ever with the deck silent,
 * which is why the suppression is now shown rather than merely applied.
 */
export function looksLikeAnInboundPitch(row: {
  is_pitch: boolean;
  has_assessment: boolean;
  last_body: string | null;
}): boolean {
  if (row.is_pitch) return true;
  if (row.has_assessment || !row.last_body) return false;
  return scoreLead({ text: row.last_body }).category === "inbound_pitch";
}


/**
 * The WhatsApp numbers of everyone who works here, across every business.
 *
 * ============================================================
 * WHY CROSS-TENANT, AND WHY A SET RATHER THAN A JOIN
 * ============================================================
 *
 * On 2026-08-27 an urgent finding had stood for 187 hours saying a customer had
 * been waiting since the 19th. It was the owner of Juris Prime Legal -- its
 * lawyer -- messaging the shared number from his own phone. Eight days of red on
 * the one signal that has to stay trustworthy, for a colleague.
 *
 * The obvious fix is an EXISTS against `employees` inside the query, and it does
 * not work here. `employees` is tenant-scoped, the unanswered query runs inside
 * the NUMBER OWNER's transaction, and the colleague works for a different
 * business on the same number -- so RLS would hide him and the subquery would
 * return false. Correct-looking SQL, zero rows, and the finding stays. That is
 * this codebase's signature defect and it would have landed squarely in the fix
 * for it.
 *
 * So the roster is read once, cross-tenant, with a reason, and the judgement
 * happens in memory beside the pitch rule -- which is also why both are shared
 * by the operator and by the view of what it suppressed.
 */
export async function staffWhatsAppNumbers(): Promise<Set<string>> {
  const { rows } = await withAllTenants(
    "reading every business's staff numbers to tell a colleague from a customer on the shared number",
    () =>
      getPool().query<{ wa: string }>(
        `select regexp_replace(whatsapp_number, '[^0-9]', '', 'g') as wa
           from employees
          where is_active = true and coalesce(whatsapp_number, '') <> ''`
      )
  );
  return new Set(rows.map((row: { wa: string }) => row.wa).filter((wa: string) => wa.length >= 8));
}

/**
 * Is this "customer" one of ours?
 *
 * Separate from the pitch rule on purpose: they suppress for different reasons
 * and a reader needs to know which. "We judged this a salesman" is a call that
 * can be wrong; "this number is on our own rota" is a fact.
 */
export function looksLikeAColleague(row: { wa_id: string }, staff: Set<string>): boolean {
  return staff.has((row.wa_id ?? "").replace(/[^0-9]/g, ""));
}

/**
 * The unanswered conversations this platform decided NOT to tell anybody about.
 *
 * An empty findings list must not read as good news unless it IS good news,
 * and until now "nothing is waiting" and "two people are waiting and we judged
 * them salesmen" looked identical from every screen. The judgement happened in
 * a filter in memory, every ten minutes, and left no trace.
 */
export async function unansweredButNotReportedFor(organizationId: string) {
  const [rows, staff] = await Promise.all([
    unansweredConversations(organizationId, true),
    staffWhatsAppNumbers(),
  ]);
  return rows
    .filter((row) => looksLikeAnInboundPitch(row) || looksLikeAColleague(row, staff))
    .map((row) => ({
    conversationId: row.conversation_id,
    servingOrganizationId: row.serving_organization_id,
    who: row.contact_name ?? `+${row.wa_id}`,
    waitedHours: Number(row.waited_hours),
    // The customer's own words, trimmed. This is the evidence for the
    // judgement, and without it "we think this is a pitch" is unreviewable.
    excerpt: (row.last_body ?? "").slice(0, 140),
    // Which of the two routes silenced it, because they need different
    // answers: a stored classification is wrong in the data, a recomputed one
    // is wrong in the rules.
    classified: row.is_pitch,
    // Which rule silenced it. A colleague is a FACT about the number; a pitch is
    // a judgement that can be wrong, and the two must not be read alike on a
    // list whose whole purpose is auditing suppression.
    reason: looksLikeAColleague(row, staff) ? ("colleague" as const) : ("pitch" as const),
  }));
}
/**
 * What every business's sweep chose not to report, in one list.
 *
 * Per business and inside that business's own transaction, exactly as the
 * sweep runs -- because the query is keyed on the number's OWNER and a routed
 * conversation is visible only inside the owner's turn. Asking this
 * cross-tenant would return the rows and lose which business each belongs to,
 * which is the mistake migration 053 exists to record.
 */
export async function unansweredButNotReported(): Promise<
  Array<Awaited<ReturnType<typeof unansweredButNotReportedFor>>[number] & { businessSlug: string }>
> {
  const organizations = await listOrganizations();
  const slugById = new Map(organizations.map((o) => [o.id, o.slug]));
  const out = [];

  for (const organization of organizations) {
    try {
      const rows = await withTenant(organization.id, () =>
        unansweredButNotReportedFor(organization.id)
      );
      for (const row of rows) {
        out.push({
          ...row,
          // The SERVING business, the same way a finding names it. Labelling
          // these with the number's owner would tell somebody to chase the
          // wrong firm -- the precise defect measured on 2026-08-19.
          businessSlug: slugById.get(row.servingOrganizationId) ?? organization.slug,
        });
      }
    } catch (err) {
      // One business failing must not empty the list for the rest. An empty
      // list here reads as "nothing was suppressed", which is the sentence
      // this whole view exists to stop being said falsely.
      logger.warn({ organizationId: organization.id, err }, "Could not read suppressed conversations");
    }
  }

  return out.sort((a, b) => b.waitedHours - a.waitedHours);
}
const customerWaiting: Operator = {
  slug: "customer-waiting",
  title: "Customer waiting",
  description:
    "Someone messaged and nothing has gone back. Normally the agent answers in seconds, so each finding works out which of four things happened — a handover nobody picked up, a colleague who replied and then stopped, a deliberate silence the agent recorded, or a message the reply path never accounted for at all.",
  run: async (organizationId, sweep) => {
    const rows = await unansweredConversations(organizationId, false);
    const staff = sweep.staffNumbers;

    return rows
      // The pitch rule, named once in `looksLikeAnInboundPitch` and shared
      // with the view of what it silenced. It used to be written out here,
      // where nothing else could see the judgement or count how often it was
      // made -- so "nothing is waiting" and "two people are waiting and we
      // judged them salesmen" were indistinguishable from every screen.
      .filter((row) => !looksLikeAnInboundPitch(row))
      // AND NOT ONE OF OUR OWN. Measured 2026-08-27: an urgent finding had
      // stood for 187 hours naming a waiting customer who turned out to be the
      // owner and lawyer of one of the five businesses, messaging the shared
      // number from his own phone. Eight days of red on the one signal that has
      // to stay trustworthy.
      //
      // Suppressed rather than downgraded, and SHOWN in the not-reported list
      // with its reason, because the rule that hides a real customer must be
      // auditable -- which is the same argument the pitch rule already lost and
      // had to answer.
      .filter((row) => !looksLikeAColleague(row, staff))
      .map((row) => {
      const hours = Number(row.waited_hours);
      const who = row.contact_name ?? `+${row.wa_id}`;
      return {
        fingerprint: row.conversation_id,
        severity: hours >= WAITING_URGENT_HOURS ? "urgent" : "warn",
        title: `${who} has been waiting ${hours} hours for a reply`,
        detail: whyNobodyAnswered(row),
        subjectKind: "conversation",
        subjectId: row.conversation_id,
        servingOrganizationId: row.serving_organization_id,
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
/**
 * The knowledge base is ageing faster than it is being refreshed.
 *
 * ============================================================
 * THE FAILURE NOTHING ELSE WATCHES
 * ============================================================
 *
 * `broken-knowledge` watches sources marked FAILED. `schedule-stalled` watches
 * the re-index stopping. `job-failing` watches it throwing. All three were
 * green on 2026-08-22 while 20 of juris-prime-legal's 25 pages were over a day
 * old, because none of them watches the outcome those three exist to protect:
 * whether the pages the agent answers from are actually current.
 *
 * The starvation is silent by construction. The sweep takes the twenty stalest
 * sources across the platform every six hours -- eighty a day against
 * sixty-five sources, so it keeps up today with headroom. One more business
 * with a forty-page site removes that headroom, and nothing about onboarding a
 * business announces that the refresh has stopped covering everybody. Every
 * source still says `indexed`, every job still reports success, and each reply
 * is built from a progressively older copy of the page WITH A CITATION
 * ATTACHED, which is the failure retrieval was built to avoid.
 *
 * ============================================================
 * THE THRESHOLD IS DERIVED, NOT CHOSEN
 * ============================================================
 *
 * A source becomes eligible at KNOWLEDGE_STALE_AFTER_HOURS and then waits up to
 * one interval for the next run, so the designed worst case is threshold +
 * interval -- 30 hours. Measured the day this was written, the oldest source on
 * production was 28.5 hours: INSIDE the bound, and a threshold picked by eye
 * would very likely have sat below it and fired on a healthy platform.
 *
 * Doubled, so a single missed cycle is not an alarm. The point is a sweep that
 * has stopped covering the estate, not one that ran late once.
 */
const knowledgeNotRefreshing: Operator = {
  slug: "knowledge-not-refreshing",
  title: "The agent is answering from stale pages",
  description:
    "This business's knowledge sources are older than the refresh schedule should ever leave them. Nothing else reports it: the sources are not failing, the job is not stopped and it is not throwing — there are simply more pages on the platform than the sweep can revisit, so the oldest ones keep ageing and every answer is built from a copy that has drifted.",
  run: async (organizationId) => {
    const boundHours = knowledgeRefreshBoundHours() * 2;

    const { rows } = await getPool().query<{
      oldest_hours: string;
      stale: string;
      total: string;
    }>(
      `select round(extract(epoch from (now() - min(last_checked_at))) / 3600.0, 1)::text as oldest_hours,
              count(*) filter (where last_checked_at < now() - ($2 || ' hours')::interval)::text as stale,
              count(*)::text as total
         from knowledge_sources
        where organization_id = $1
          and last_checked_at is not null`,
      [organizationId, String(boundHours)]
    );

    const row = rows[0];
    const stale = Number(row?.stale ?? 0);
    if (stale === 0) return [];

    // Platform-wide, so it is the same number in every business's finding --
    // and that is the point: this is not that business's fault and cannot be
    // fixed inside it.
    const capacity = knowledgeRefreshCapacityPerDay();
    const estate = await countKnowledgeSourcesAcrossPlatform();

    return [
      {
        fingerprint: "knowledge-not-refreshing",
        severity: "warn" as const,
        title: `${stale} of this business's pages have not been re-read in ${Math.round(Number(row?.oldest_hours ?? 0))} hours`,
        detail:
          `The re-index should never leave a page older than ${knowledgeRefreshBoundHours()} hours. ` +
          `Nothing is failing — every source still reports as indexed and the job is running — ` +
          `there are simply ${estate} pages on the platform and the sweep can revisit ${capacity} a day. ` +
          (estate > capacity
            ? `That is more than it can cover, so the oldest pages will keep ageing until either the ` +
              `schedule runs more often or fewer pages are tracked.`
            : `That is within capacity, so this is more likely a run that failed or a site that stopped ` +
              `responding — check the re-index job.`) +
          ` Until it clears, answers about these pages are written from a copy that may have moved on, ` +
          `and the reply still cites them.`,
        subjectKind: "organization",
        subjectId: null,
      } satisfies FindingInput,
    ];
  },
};

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

/**
 * Wording a business wrote and never switched on.
 *
 * FOUND ON PRODUCTION 2026-08-19. ABR — a criminal defence firm — has authored
 * `no_one_available` wording sitting inactive:
 *
 *   "There is nobody at the desk to take this over right now, so I will keep
 *    helping where I can. Anything I say is general information, not legal
 *    advice. If this is urgent - a police station, a court date, or a deadline
 *    today - do not wait on this chat; call us on {{office_number}}."
 *
 * While it is off, their customers get the platform default instead:
 *
 *   "I want to make sure you get an accurate answer, so I'm looping in a
 *    specialist from our team. They'll follow up shortly."
 *
 * A legal disclaimer and an urgent route, replaced by a promise of follow-up —
 * which, fired precisely when nobody is on shift, is the false promise this
 * platform has already been burned by twice.
 *
 * IT IS OFF FOR A GOOD REASON AND THAT IS THE POINT. The route refuses to
 * activate wording that still contains a `{{placeholder}}`, correctly: sending
 * a customer literal curly braces where a phone number belongs would be worse,
 * and on this particular sentence far worse. The guard worked. What never
 * happened is anybody being TOLD, so the firm wrote its wording, the platform
 * quietly declined it, and both sides have been waiting since.
 *
 * `procedure-awaiting-review` already does exactly this for inferred
 * procedures. Wording had no equivalent, which is why this one sat unnoticed.
 *
 * NAMES THE PLACEHOLDER, because "your wording is inactive" is a description
 * and "it needs office_number" is a task. Anything a person cannot act on from
 * the notification alone becomes something they look at later.
 */
/**
 * An agent that offers appointments for a business with nobody to book.
 *
 * MEASURED ON PRODUCTION 2026-08-19, by asking the real availability engine
 * what each business could offer a customer right now:
 *
 *   abr                  0 slots offerable   <- agent offers booking
 *   juris-prime          3 slots offerable
 *   juris-prime-legal    0 slots offerable   <- agent offers booking
 *   sfs-international    0 slots offerable   <- agent offers booking
 *   zipicka              3 slots offerable
 *
 * Three firms advertise a capability that cannot work. A customer asks ABR for
 * a consultation, the agent reaches for `check_availability`, and
 * `findAvailableSlots` returns an empty list because the business has no active
 * employee with a schedule — so the customer is told nobody is available to
 * take appointments. Not once: every time, permanently, until somebody adds
 * staff.
 *
 * NOBODY LEARNS THIS. The reply is graceful, the tool did not error, no
 * exception was raised, and the firm's own screens show a booking-capable
 * agent. The only visible trace is a customer who asked for an appointment and
 * did not get one, which looks like an ordinary conversation.
 *
 * Migration 032 already asserts the near-miss version of this — that every
 * agent which can book can also check the diary, so it never offers a slot
 * outside working hours. The complement was never checked: that there is
 * anybody in the diary at all.
 *
 * A WARNING, NOT URGENT. Nobody is waiting and nothing is broken; a capability
 * is inert. Putting it beside "a customer has been waiting a day" would be
 * wrong in both directions.
 *
 * Two actions, and the finding names both, because "you have no staff" is a
 * description of the business rather than a task.
 */
/*
 * WHAT A CUSTOMER ACTUALLY GETS, measured rather than assumed.
 *
 * This finding first said every appointment request "is answered with 'nobody
 * is available'". That was written from the operator's side of the problem and
 * asserted a customer experience nobody had checked. Running findAvailableSlots
 * against the three flagged businesses in production returned zero slots for
 * each -- and zero slots is not an error and not a dead end: check_availability
 * turns an empty result into a note telling the model to offer a colleague
 * follow-up. The agent degrades gracefully.
 *
 * So the finding stands and its reason moved. The cost is not a rude answer; it
 * is that an appointment request becomes a callback promise, and a business
 * with nobody on the rota has nobody to make that call either -- which then
 * surfaces as unowned-followup, one operator further on.
 *
 * A finding that overstates its own consequence is the same failure as a badge
 * that cannot be cleared: it spends the reader's trust, and the reader stops
 * spending attention back.
 */
const bookingWithoutAnyone: Operator = {
  slug: "booking-without-anyone",
  title: "Booking is configured, and switched off because nobody is on a rota",
  description:
    "This business's agent is configured to book appointments, but no member of staff has working hours — so the diary can never offer a time. The platform withholds the booking tools rather than let the agent offer what nobody can take, and gives them back as soon as somebody is on the rota.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{ id: string; staff: string }>(
      `select ac.id,
              (
                select count(*)::text from employees e
                 where e.organization_id = ac.organization_id and e.is_active
              ) as staff
         from agent_configs ac
        where ac.organization_id = $1
          and ac.is_active
          and ac.tools ? 'book_appointment'
          -- Nobody who could ever be offered. A rota is what turns an employee
          -- into a bookable one: findAvailableSlots reads working_hours, and an
          -- empty schedule matches no window, ever. So an active employee with
          -- no hours is counted here as nobody, which is what the diary does
          -- with them.
          and not exists (
            select 1 from employees e
             where e.organization_id = ac.organization_id
               and e.is_active
               and e.working_hours is not null
               and e.working_hours <> '{}'::jsonb
          )`,
      [organizationId]
    );

    return rows.map((row) => {
      const staff = Number(row.staff ?? 0);
      return {
        fingerprint: "booking-without-anyone",
        severity: "warn" as const,
        title: "Booking is configured, and switched off because nobody is on a rota",
        // WHAT THE PLATFORM DOES, not what the customer experiences. The
        // earlier wording of this finding asserted a customer experience
        // nobody had measured and had to be corrected once already; the
        // sentences below describe only this platform's own behaviour, which
        // is checkable from the code that performs it.
        detail:
          staff > 0
            ? `Your agent is set up to book appointments, and ${staff === 1 ? "your one member of staff has" : `all ${staff} of your staff have`} no working hours set — so the diary can never offer a time. Rather than let the agent offer appointments nobody can take, the platform withholds booking from it entirely: it will not offer or take an appointment for you at all. Set working hours on the Team screen and booking switches itself back on.`
            : "Your agent is set up to book appointments and this business has no active staff — so the diary can never offer a time. Rather than let the agent offer appointments nobody can take, the platform withholds booking from it entirely: it will not offer or take an appointment for you at all. Add someone on the Team screen and give them working hours, and booking switches itself back on.",
        subjectKind: "agent_config",
        subjectId: row.id,
      } satisfies FindingInput;
    });
  },
};

/**
 * RULE 5 OF THE AUTOMATIC ACTIVATION: it is never silent.
 *
 * F14's refusal was that "the judgement of whether a rate is wrong belongs to
 * someone who knows the business". The owner asked for the feature finished, so
 * that judgement now lives in `autoActivationDecision`. This is what stops that
 * being a quiet transfer: every procedure the platform switched on and nobody
 * has reviewed shows up in the same list the business already reads.
 *
 * Computed from STATE, not from the activation event, which is what makes it
 * retract properly. The moment a person opens it and switches it off — or looks
 * at it and leaves it on — `reviewed_by` stops being the automation's marker and
 * this finding disappears on the next sweep. It says "nobody has looked at this
 * yet", and it stops saying it the moment somebody has.
 *
 * `info`, not `warn`. Nothing is wrong: this is the feature working as asked
 * for. But an agent following a method nobody approved is worth a sentence.
 */
const procedureSwitchedOn: Operator = {
  slug: "procedure-switched-on",
  title: "The agent is following a method nobody has approved",
  description:
    "This platform inferred a way of handling a kind of enquiry from conversations that went well, found enough evidence to trust it, and switched it on by itself. It is live now. Nobody at this business has looked at it yet.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      id: string;
      intent_category: string;
      language: string;
      derived_from_count: string;
      days: string;
    }>(
      `select p.id,
              p.intent_category,
              p.language,
              p.derived_from_count::text,
              extract(day from now() - p.reviewed_at)::text as days
         from procedures p
        where p.organization_id = $1
          and p.is_active
          -- The automation's own marker. A procedure a PERSON switched on is
          -- not this operator's business, and neither is one a person has since
          -- reviewed: reviewed_by changes and this finding retracts itself.
          and p.reviewed_by = $2
        order by p.reviewed_at asc`,
      [organizationId, AUTO_REVIEWER]
    );

    return rows.map((row) => {
      const days = Number(row.days ?? 0);
      return {
        // One per procedure, so switching one off retracts only that one.
        fingerprint: `procedure-switched-on:${row.id}`,
        severity: "info" as const,
        title: "The agent is following a method nobody has approved",
        detail:
          `Your agent is now handling "${row.intent_category.replace(/_/g, " ")}" enquiries ` +
          `by a method this platform worked out for itself, from ${row.derived_from_count} ` +
          `conversations that went well. It switched on ` +
          (days >= 1 ? `${days} day${days === 1 ? "" : "s"} ago` : "today") +
          ` and nobody here has looked at it. Read it on the How we answer screen — if it is ` +
          `wrong, switching it off is one click and this platform will not switch it back on.`,
        subjectKind: "procedure",
        subjectId: row.id,
      } satisfies FindingInput;
    });
  },
};

const wordingAwaitingReview: Operator = {
  slug: "wording-awaiting-review",
  title: "Your own wording is switched off",
  description:
    "This business wrote its own version of a message the agent sends, and it is not being used. Until it is switched on, customers get the platform's generic wording instead.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      id: string;
      moment: string;
      needs: string | null;
      days: string;
    }>(
      `select p.id,
              p.moment,
              -- Every distinct {{placeholder}} still in the body, so the finding
              -- can say what is actually missing rather than that something is.
              (
                select string_agg(distinct m[1], ', ' order by m[1])
                  from regexp_matches(p.body, '\{\{([a-z0-9_]+)\}\}', 'g') as m
              ) as needs,
              extract(day from now() - p.created_at)::text as days
         from agent_phrases p
        where p.organization_id = $1
          and p.is_active = false
          -- Authored by this business, not catalogue wording nobody has looked
          -- at. Somebody sat down and wrote this; that is what makes it worth
          -- interrupting them about.
          and p.source <> 'catalog'
          -- Nothing else is active for that moment. If they have since written
          -- a replacement and switched THAT on, this one is a discarded draft
          -- and reporting it is noise.
          and not exists (
            select 1 from agent_phrases live
             where live.organization_id = p.organization_id
               and live.moment = p.moment
               and live.language = p.language
               and live.is_active
          )
        order by p.created_at asc`,
      [organizationId]
    );

    if (rows.length === 0) return [];

    return rows.map((row) => {
      const days = Number(row.days ?? 0);
      const age = days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : "today";
      return {
        fingerprint: `wording-${row.moment}`,
        // A warning, not urgent. The customer is getting a worse sentence, not
        // no sentence — and treating it as urgent would put it beside "a
        // customer has been waiting a day", which is not the same thing.
        severity: "warn" as const,
        title: row.needs
          ? `Your "${row.moment}" wording needs ${row.needs} before it can be switched on`
          : `Your "${row.moment}" wording is written but switched off`,
        detail: row.needs
          ? `Written ${age} ago and still not in use. It cannot be activated while it contains {{${row.needs}}} — a customer would receive that literally. Fill it in on the Procedures screen, under "What we say", and switch it on; until then they get the platform's generic message instead of yours.`
          : `Written ${age} ago and never switched on, so customers get the platform's generic message instead of yours. Switch it on from the Procedures screen, under "What we say", or delete it if you have changed your mind.`,
        subjectKind: "phrase",
        // The phrase itself, so the finding is a link to the thing that needs
        // editing. operator-fire-check refuses a finding with no subject, and
        // was right to: an alert you cannot click through to is one somebody
        // has to go hunting from.
        subjectId: row.id,
      } satisfies FindingInput;
    });
  },
};

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

/**
 * The shared number's standing, read once per sweep.
 *
 * Every business here answers on one WhatsApp account, so this asks Meta once
 * and hands the answer to all of them. Failure returns null rather than
 * throwing: the standing operator stands down on null, and every other operator
 * still has work to do when Meta is unreachable.
 */
async function readSharedNumberStanding(): Promise<AccountStanding | null> {
  try {
    const organizations = await listOrganizations();
    const waba = organizations.find((o) => o.whatsappBusinessAccountId)?.whatsappBusinessAccountId;
    if (!waba) return null;
    return await readAccountStanding(waba);
  } catch (err) {
    logger.warn({ err }, "Could not read the WhatsApp account's standing — operators continue without it");
    return null;
  }
}

// The standing of the number everything else depends on.
//
// ============================================================
// TWENTY-THREE OPERATORS AND NONE OF THEM LOOKED AT THIS
// ============================================================
//
// Everything else here watches what happens INSIDE the platform: conversations
// waiting, knowledge going stale, jobs stalling. All of it assumes the messages
// actually leave. Whether they do is decided by three facts held at Meta, and
// nothing read any of them.
//
//   QUALITY. A number rated YELLOW or RED is throttled by Meta. Replies arrive
//   late or not at all, which looks exactly like a platform fault and is not
//   one — and the rating belongs to ONE number six businesses answer on, so a
//   single business's bulk send degrades everybody's ordinary replies.
//
//   THE DAILY CEILING. An unverified business is capped at 250 unique customers
//   per day, across every business on the number. Nobody would discover that
//   until a campaign stopped delivering partway through, silently.
//
//   VERIFICATION. What sets that ceiling. It is the owner's to fix — legal
//   documents in Business Manager — and it can sit rejected indefinitely while
//   everyone assumes the limit is something the platform chose.
//
// Raised against every business, like template-rejected, because the fact is
// true for every business: they share the number.
const accountStanding: Operator = {
  slug: "account-standing",
  title: "The WhatsApp number is not in full standing",
  description:
    "Quality rating, daily customer ceiling and business verification, as Meta reports them. These decide whether anything sent actually arrives.",
  run: async (organizationId, sweep) => {

    const standing = sweep.numberStanding;
    // Null means the sweep could not reach Meta. STANDS DOWN rather than
    // reporting a platform defect: an outage at Meta says nothing about this
    // account, and an alarm that fires on somebody else's outage is one people
    // learn to ignore.
    if (!standing) return [];

    const findings = [];

    // Quality first: it is the one that is actively costing delivery today.
    const quality = (standing.quality ?? "").toUpperCase();
    if (quality === "RED" || quality === "YELLOW") {
      findings.push({
        fingerprint: `number-quality-${quality.toLowerCase()}`,
        severity: quality === "RED" ? ("urgent" as const) : ("warn" as const),
        title: `WhatsApp has rated ${standing.displayNumber} ${quality}`,
        detail:
          `Meta throttles a number at this rating, so replies to real customers arrive late or not at all — ` +
          `and this number carries every business here. It is caused by people blocking or reporting messages, ` +
          `which in practice means a campaign that went to the wrong list. Stop non-essential sending until it ` +
          `returns to GREEN.`,
        subjectKind: "organization",
        subjectId: organizationId,
      });
    }

    // Then the ceiling, and only when it is low enough to actually bind.
    const verification = (standing.businessVerification ?? "").toLowerCase();
    if (verification && verification !== "verified") {
      findings.push({
        fingerprint: "business-not-verified",
        severity: "warn" as const,
        title: `Business verification is ${verification}`,
        detail:
          `Until the business behind this WhatsApp account is verified, Meta caps it at ` +
          `${standing.dailyCustomerLimit ?? "a low number of"} unique customers per day — shared across all ` +
          `businesses on ${standing.displayNumber}. Campaigns silently stop delivering once it is reached. ` +
          `Verification is done by the owner in Business Manager under Security Centre, with the trade licence ` +
          `and proof of address; nothing on this platform can complete it.`,
        subjectKind: "organization",
        subjectId: organizationId,
      });
    }

    return findings;
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
        -- WHO TALKED TO THIS BUSINESS, which is not who owns the contact row.
        --
        -- A contact is created by the number's owner, before anybody knows
        -- which of the five firms is being asked for -- so keyed on
        -- ct.organization_id, this list offers Zipicka people who have only ever
        -- spoken to Juris Prime, and offers Juris Prime nobody at all.
        --
        -- The served_organization_ids array is what migration 055 added and keeps
        -- true by trigger. It is an array precisely because of this case: the
        -- same person may ask the letting agent about a flat and the law firm
        -- about a lease, and both should be able to follow up with them.
        --
        -- This is the last of the seven readers that keyed a per-business
        -- question on the number's owner, and the only one where the answer had
        -- to be a set rather than a column.
        where ($1::uuid = any (ct.served_organization_ids)
               or (cardinality(ct.served_organization_ids) = 0
                   and ct.organization_id = $1))
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
        -- SERVING, NOT OWNING. All five businesses answer on one number, so a
        -- routed conversation's rows carry the owner's organization_id. Keyed
        -- on that, this alarm fires at Zipicka about another firm's traffic
        -- and stays silent on the page belonging to the firm that can fix it.
        -- The column is filled by the trigger from migration 054.
        where serving_organization_id = $1
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
        -- SERVING, NOT OWNING. All five businesses answer on one number, so a
        -- routed conversation's rows carry the owner's organization_id. Keyed
        -- on that, this alarm fires at Zipicka about another firm's traffic
        -- and stays silent on the page belonging to the firm that can fix it.
        -- The column is filled by the trigger from migration 054.
        where serving_organization_id = $1
          and recorded_at > now() - ($2 || ' hours')::interval
          -- A message the agent stood down from never reached the classifier,
          -- so its null intent is expected rather than a fault. Counting it
          -- would raise this URGENT every time a person takes a conversation
          -- over -- which is the normal, correct operation of the platform.
          -- See migration 057.
          and coalesce(reply_outcome, '') <> 'skipped_handover'`,
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
/**
 * TWELVE HOURS WAS NEVER ARGUED, AND THE OPERATOR'S OWN REASONING CONTRADICTS IT.
 *
 * The severity below says "always urgent — there is no gentle version of a
 * customer who was promised a person and then cut off from the only thing
 * answering them". That is a good argument, and it is an argument for saying so
 * SOONER. Staying silent for half a day about a state described as having no
 * gentle version is the two positions disagreeing in the same file.
 *
 * Set to match `customer-waiting`'s warn threshold, because a handover is the
 * stronger fact of the two: an unanswered message is a business being slow, and
 * this is a business having PROMISED. Catching the weaker one in two hours and
 * the stronger one in twelve is the wrong way round.
 *
 * It cannot be noisy in the way a two-hour threshold usually is. The condition
 * is not "quiet for two hours" — it is handover flagged, AND no `human_agent`
 * message has ever existed in the conversation, AND it is not a cold pitch. A
 * business whose staff answer within the hour never sees it, and one whose staff
 * never answer at all should be seeing it.
 *
 * The concrete reason it changed today: the customer answered on 18 August was
 * ignored for twenty-two hours, and the state that ignored them is the one this
 * operator watches. Their next message is likely to escalate again — Juris Prime
 * is on the strict governance tier and its agent scored medium on exactly this
 * kind of question three times in a row — so the same twelve-hour silence was
 * about to be available for the same customer.
 */
const ABANDONED_HANDOVER_HOURS = 2;

const handoverAbandoned: Operator = {
  slug: "handover-abandoned",
  title: "A handover nobody came to",
  description:
    "The agent promised a colleague and paused itself, and no colleague has ever replied. The customer was told help was coming and then heard nothing, and because the agent spoke last this looks like an answered conversation to every other check.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      conversation_id: string;
      serving_organization_id: string;
      contact_name: string | null;
      wa_id: string;
      paused_hours: string;
      last_body: string | null;
      has_assessment: boolean;
    }>(
      `select c.id as conversation_id,
              -- The business that was supposed to send the colleague. Same
              -- reason as customer-waiting: this can only be seen from the
              -- number owner's transaction, so without this the promise is
              -- chased at the wrong firm. See migration 053.
              coalesce(c.routed_organization_id, c.organization_id) as serving_organization_id,
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
      // THE SAME DECISION AS customer-waiting, and now literally the same
      // function. It was a second copy of the fallback until 2026-08-25 --
      // identical reasoning, identical code, two places to keep right. The
      // day they drifted, one operator would silence a conversation the other
      // reported, and nothing would say which was correct.
      //
      // is_pitch is false by construction here: the query above already
      // excludes anything carrying that classification, so the only judgement
      // left for this to make is the re-read one.
      .filter(
        (row) =>
          !looksLikeAnInboundPitch({
            is_pitch: false,
            has_assessment: row.has_assessment,
            last_body: row.last_body,
          })
      )
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
          servingOrganizationId: row.serving_organization_id,
        } satisfies FindingInput;
      });
  },
};

/**
 * The business believes it replied. WhatsApp says the customer never got it.
 *
 * Until migration 048 this operator could not have existed, because the fact it
 * watches was not recorded anywhere: `insertOutboundMessage` wrote the literal
 * 'sent' on every row, and the status webhook that would have corrected it was
 * counted in a log line and dropped. A reply Meta accepted and then failed to
 * deliver looked exactly like one the customer read — in the inbox, in the
 * database, and to every rollup computed from them.
 *
 * TWO STATES, ONE FINDING, AND THE SECOND IS THE ONE WORTH HAVING.
 *
 *   failed  — Meta said so, and said why. Unambiguous and urgent.
 *   queued  — Meta accepted it and has since said NOTHING. No error exists to
 *             find. This is the shape almost every defect on this platform has
 *             taken: not a failure, but an absence that reads as success.
 *
 * The grace period is what makes the second state meaningful rather than noisy.
 * A receipt normally lands within seconds; a message still unconfirmed after an
 * hour is not in flight, it is lost — and the honest thing to say about it is
 * that nobody knows, which is exactly what the detail says.
 */
const UNCONFIRMED_GRACE_MINUTES = 60;
const DELIVERY_LOOKBACK_HOURS = 24;

const deliveryFailing: Operator = {
  slug: "delivery-failing",
  title: "Replies are not reaching customers",
  description:
    "Messages this business believes it sent were rejected by WhatsApp, or were accepted and never confirmed. The conversation looks answered from the inside and is silent from the customer's side.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      failed: string;
      unconfirmed: string;
      total: string;
      reason: string | null;
    }>(
      `select count(*) filter (where status = 'failed')::text as failed,
              count(*) filter (
                where status = 'queued'
                  and created_at < now() - ($3 || ' minutes')::interval
              )::text as unconfirmed,
              count(*)::text as total,
              -- Meta's own words, not a code of ours. One example is worth more
              -- than a count: "re-engagement message" and "recipient has not
              -- accepted our new terms" call for completely different actions.
              (array_agg(delivery_error) filter (where delivery_error is not null))[1] as reason
         from messages
        -- SERVING, NOT OWNING. All five businesses answer on one number, so a
        -- routed conversation's rows carry the owner's organization_id. Keyed
        -- on that, this alarm fires at Zipicka about another firm's traffic
        -- and stays silent on the page belonging to the firm that can fix it.
        -- The column is filled by the trigger from migration 054.
        where serving_organization_id = $1
          and direction = 'outbound'
          and created_at > now() - ($2 || ' hours')::interval`,
      [organizationId, String(DELIVERY_LOOKBACK_HOURS), String(UNCONFIRMED_GRACE_MINUTES)]
    );

    const failed = Number(rows[0]?.failed ?? 0);
    const unconfirmed = Number(rows[0]?.unconfirmed ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    const reason = rows[0]?.reason ?? null;
    if (failed === 0 && unconfirmed === 0) return [];

    // Urgent on a confirmed failure: somebody asked a question and this
    // business's answer does not exist as far as WhatsApp is concerned. A
    // warning on unconfirmed, because "no receipt" is genuinely ambiguous and
    // an operator that cried outage over a slow webhook would be switched off.
    return [
      {
        fingerprint: "delivery-failing",
        severity: failed > 0 ? ("urgent" as const) : ("warn" as const),
        title:
          failed > 0
            ? `${failed} of ${total} replies were rejected by WhatsApp`
            : `${unconfirmed} replies were never confirmed delivered`,
        detail:
          failed > 0
            ? `In the last ${DELIVERY_LOOKBACK_HOURS} hours WhatsApp rejected ${failed} outbound messages${reason ? ` — Meta's reason: "${reason}"` : ""}. Those customers never received a reply, and the conversation reads as answered from this side.${unconfirmed > 0 ? ` A further ${unconfirmed} have no receipt at all.` : ""} Check the number's quality rating and messaging limits before assuming the content was at fault.`
            : `${unconfirmed} of ${total} outbound messages in the last ${DELIVERY_LOOKBACK_HOURS} hours were accepted by Meta and never confirmed sent, delivered or read — no error, just silence, for over ${UNCONFIRMED_GRACE_MINUTES} minutes. That is either the status webhook not reaching us or messages not reaching customers, and those need telling apart: check that the account is subscribed to the \`messages\` field before looking at delivery.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

/**
 * The agent is answering nobody, and every container is green.
 *
 * THIS OPERATOR IS A RESPONSE TO TWO REAL OUTAGES, not a hypothetical.
 * `gemini-2.5-flash` began returning 404 for newly-created API keys while
 * `models.list` still advertised it; separately, an Anthropic key ran out of
 * credit. Both times every customer received "I'm looping in a specialist", the
 * health checks passed, and nothing anywhere could move — because a reply that
 * threw jumped past the metric write, so the failures were not merely
 * unmonitored, they were UNRECORDED.
 *
 * `preflightModels()` catches a broken model at worker boot, which is the wrong
 * moment: both outages began while the worker was already running and neither
 * would have restarted it. Migration 049 records what the customer actually
 * received, and this is the thing that reads it.
 *
 * Two thresholds, and both are deliberate.
 *
 *   ANY `none` is urgent. That value means the fallback failed too and the
 *   customer received nothing at all — the worst state this platform can
 *   reach, and one nobody would otherwise discover.
 *
 *   `fallback` warns, and turns urgent at three. One is a blip: a timeout, a
 *   rate limit, a single malformed tool call. Three in six hours is not a blip,
 *   it is a provider, and the outages this exists for produced every reply for
 *   hours rather than three.
 */
const REPLY_LOOKBACK_HOURS = 6;
const FALLBACK_URGENT_AT = 3;

const agentUnavailable: Operator = {
  slug: "agent-unavailable",
  title: "The agent cannot answer, and is saying so to everybody",
  description:
    "Replies are coming out as the platform's fallback sentence instead of real answers — usually the model provider being unreachable, out of credit, or a model retired underneath us. Every health check passes while this happens.",
  run: async (organizationId) => {
    const { rows } = await getPool().query<{
      fallback: string;
      none: string;
      total: string;
    }>(
      `select count(*) filter (where reply_outcome = 'fallback')::text as fallback,
              count(*) filter (where reply_outcome = 'none')::text as none,
              -- EXCLUDED FROM THE DENOMINATOR TOO, and that is the half worth
              -- stating. A message the agent stood down from was never a chance
              -- for the agent to fail, so leaving it in the total would make the
              -- failure rate look better the more conversations humans take
              -- over. That is migration 049's argument pointing the other way:
              -- a fraction is wrong if the wrong things are underneath it.
              count(*) filter (
                where reply_outcome is not null
                  and reply_outcome <> 'skipped_handover'
              )::text as total
         from conversation_metrics
        -- SERVING, NOT OWNING. All five businesses answer on one number, so a
        -- routed conversation's rows carry the owner's organization_id. Keyed
        -- on that, this alarm fires at Zipicka about another firm's traffic
        -- and stays silent on the page belonging to the firm that can fix it.
        -- The column is filled by the trigger from migration 054.
        where serving_organization_id = $1
          and recorded_at > now() - ($2 || ' hours')::interval`,
      [organizationId, String(REPLY_LOOKBACK_HOURS)]
    );

    const fallback = Number(rows[0]?.fallback ?? 0);
    const none = Number(rows[0]?.none ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    if (fallback === 0 && none === 0) return [];

    const silent = none > 0;
    return [
      {
        fingerprint: "agent-unavailable",
        severity: silent || fallback >= FALLBACK_URGENT_AT ? ("urgent" as const) : ("warn" as const),
        title: silent
          ? `${none} customers received NO reply at all`
          : `${fallback} of ${total} replies were the fallback, not an answer`,
        detail: silent
          ? `In the last ${REPLY_LOOKBACK_HOURS} hours ${none} messages got no response whatsoever — the agent failed and the fallback could not be delivered either.${fallback > 0 ? ` A further ${fallback} received the fallback sentence.` : ""} Those customers are waiting on a person and nothing else will reach them. Check the model provider and the WhatsApp send path, in that order.`
          : `In the last ${REPLY_LOOKBACK_HOURS} hours ${fallback} of ${total} replies were the platform's "looping in a specialist" sentence rather than an answer the agent composed. That is the model provider being unreachable, out of credit, or a model retired underneath us — check the worker log for the preflight line naming the model before assuming the content was at fault. Health checks pass throughout this; they have twice.`,
        subjectKind: "organization",
        subjectId: organizationId,
      },
    ];
  },
};

/**
 * The scheduled work stopped, and the platform looks exactly the same.
 *
 * Six things are scheduled at worker boot and every one of them is scheduled
 * best-effort, so any can fail to register or stop repeating while customer
 * messages carry on being answered. Knowledge quietly stops being re-indexed,
 * template approvals never arrive, the quality rollups freeze at their last
 * value and read as a quiet week.
 *
 * ============================================================
 * THIS OPERATOR CANNOT WATCH THE ONE THAT MATTERS MOST
 * ============================================================
 *
 * It runs INSIDE the operator sweep. If that sweep stops, this stops with it,
 * and the deck goes on reporting 0 standing findings — which is what a platform
 * with nothing wrong looks like. No operator can fix that; the check has to come
 * from outside the thing being checked, which is what `GET /health/jobs` is for.
 *
 * So `operators` is deliberately EXCLUDED here rather than silently un-watched.
 * Including it would produce a check that passes in every case where it could
 * conceivably be needed: the sweep is running, therefore the sweep is running.
 * Five of six is the honest coverage, and the sixth is named in the detail text
 * so whoever reads a finding also learns what this cannot tell them.
 */
/**
 * A job that runs and throws, which is not the same as a job that has stopped.
 *
 * ============================================================
 * WHAT schedule-stalled CANNOT SEE
 * ============================================================
 *
 * schedule-stalled judges last_finished_at, and last_finished_at only advances
 * on success. That catches a job failing EVERY time: its finish freezes, the
 * window runs out, the finding fires. It cannot catch a job failing
 * INTERMITTENTLY, because every success moves the finish forward again and the
 * window never runs out.
 *
 * knowledge-reindex is exactly that shape. Measured on 2026-08-21: sixteen
 * runs, TWO failures, and nothing on this platform ever said a word about
 * either. Both were the tenant-scope assert firing inside the ingest path, and
 * both were found by somebody reading job_heartbeats by hand, three days after
 * the fact. The consequence in between was silent: the knowledge base is
 * refreshed from whatever survived, and a page that changed is answered from
 * the old copy with a citation attached.
 *
 * ============================================================
 * WHY THIS READS A TIMESTAMP AND NOT `last_error`
 * ============================================================
 *
 * `last_error` is deliberately sticky -- the heartbeat keeps it through later
 * successes so that a job failing every other run cannot look green half the
 * time. That makes its PRESENCE useless as a signal of current health: it stays
 * true forever after one historical failure, and reading it as "this job is
 * broken" is a false alarm that can never be cleared.
 *
 * I made exactly that mistake before writing this. knowledge-reindex carried an
 * error and read as broken; it had failed on the 18th, been fixed, and
 * succeeded on every run since. What settled it was comparing last_error_at
 * against last_finished_at, which is the only pair that carries recency.
 */
const jobFailing: Operator = {
  slug: "job-failing",
  title: "Scheduled work is throwing",
  description:
    "A background job is still running to schedule but has thrown recently. Nothing else reports this: the stalled check watches for work that stops, and a job that fails and then succeeds never stops — it just quietly does less than it should, and the platform keeps looking healthy.",
  run: async (organizationId) => {
    // Same shape as schedule-stalled, and for the same reason: these rows
    // belong to no tenant, but the CONSEQUENCE is per tenant -- each business's
    // knowledge stops being refreshed, each business's rollups drift.
    const heartbeats = await listJobHeartbeats();
    const now = new Date();

    const failing = heartbeats.filter((beat) => {
      if (beat.job === "operators") return false;
      if (!hasJobFailedRecently(beat.job as ScheduledJob, beat.lastErrorAt ? new Date(beat.lastErrorAt) : null, now)) {
        return false;
      }
      // A job that is failing OUTRIGHT is schedule-stalled's finding, not this
      // one. Reporting both would put two rows on the deck for one fault and
      // make fixing it retract only half of them.
      return !isJobStalled(
        beat.job as ScheduledJob,
        beat.lastFinishedAt ? new Date(beat.lastFinishedAt) : null,
        now,
        new Date(Date.now() - process.uptime() * 1000)
      );
    });

    return failing.map((beat) => {
      const runs = Number(beat.runs ?? 0);
      const failures = Number(beat.failures ?? 0);
      const hours = beat.lastErrorAt
        ? Math.round((now.getTime() - new Date(beat.lastErrorAt).getTime()) / 3_600_000)
        : null;
      return {
        fingerprint: `job-failing:${beat.job}`,
        severity: "warn" as const,
        title: `${beat.job} is completing, but it threw ${hours === null ? "recently" : `${hours}h ago`}`,
        detail:
          `${failures} of ${runs} runs have failed. It is still finishing, so nothing else reports it — ` +
          `the stalled check only watches for work that stops entirely, and a job that fails and then ` +
          `succeeds never stops. It just does less than it should each time it throws.` +
          (beat.lastError ? ` Last error: "${beat.lastError}".` : "") +
          ` This clears itself once two of this job's intervals pass without another failure.`,
        subjectKind: "job",
        // No subjectId: a job is not a row. Keeping it null stops the deck
        // building a link to a record that does not exist.
        subjectId: null,
      } satisfies FindingInput;
    });
  },
};

const scheduleStalled: Operator = {
  slug: "schedule-stalled",
  title: "Scheduled work has stopped running",
  description:
    "A background job has not completed within its window. These are scheduled best-effort at worker boot, so one can stop while everything else keeps working — the knowledge index goes stale, template approvals never arrive, or the rollups freeze at their last value.",
  run: async (organizationId) => {
    // Not per-business, even though the finding is raised per business. These
    // rows belong to no tenant, and the CONSEQUENCE is per tenant: each
    // business's knowledge stops being re-indexed, each business's rollups
    // freeze. Raising it where the person responsible for that business will
    // see it is right; querying it per business would be five identical reads.
    const heartbeats = await listJobHeartbeats();
    const now = new Date();

    // Judged from process start, not from the epoch. A worker that came up
    // ninety seconds ago has not failed to run its daily inference — it has not
    // reached it yet, and reporting that on every deploy is the fastest way to
    // teach somebody to ignore this list.
    const bootedAt = new Date(Date.now() - process.uptime() * 1000);

    const stalled = heartbeats.filter(
      (beat) =>
        // See the note above: the sweep cannot testify to its own liveness.
        beat.job !== "operators" &&
        isJobStalled(
          beat.job as ScheduledJob,
          beat.lastFinishedAt ? new Date(beat.lastFinishedAt) : null,
          now,
          bootedAt
        )
    );

    if (stalled.length === 0) return [];

    return stalled.map((beat) => {
      const never = beat.lastFinishedAt === null;
      const hours = never
        ? null
        : Math.round((now.getTime() - new Date(beat.lastFinishedAt as string).getTime()) / 3_600_000);

      return {
        // Per job, so fixing one does not retract the others — and so the list
        // shrinks a job at a time, which is what reconciliation is for.
        fingerprint: `schedule-stalled:${beat.job}`,
        severity: "warn" as const,
        title: never
          ? `${beat.job} has never completed a run`
          : `${beat.job} last finished ${hours} hours ago`,
        detail: `${never ? "This job has not completed once since the worker started, which usually means its schedule failed to register at boot — the log line to look for is \"Could not schedule\"." : `Expected roughly every ${describeInterval(beat.job as ScheduledJob)}; last completed run finished ${hours} hours ago.`}${beat.lastError ? ` Last error: "${beat.lastError}".` : ""} Note that this check runs inside the operator sweep, so it can say nothing about whether the SWEEP itself is running — that is what GET /health/jobs answers, from outside.`,
        subjectKind: "organization",
        subjectId: organizationId,
      };
    });
  },
};

/** Human wording for a tolerance, used only in a finding's detail text. */
function describeInterval(job: ScheduledJob): string {
  const seconds = JOB_STALE_AFTER_SECONDS[job];
  const hours = seconds / 3600;
  return hours >= 24 ? "day" : hours >= 1 ? `${Math.round(hours / 3)} hours` : `${Math.round(seconds / 60)} minutes`;
}


/** A nightly dump is late once it has missed a night, not once it is late. */
const BACKUP_STALE_HOURS = 30;

/**
 * The paperwork the backup files about itself, read where somebody looks.
 *
 * `backup-db.sh` has always said all of this -- into /var/log/nexus-backup.log,
 * which is opened when somebody thinks to open it. The gate that reads the same
 * files names the remaining hole in its own header: it closes the hole where
 * nothing COULD notice, not the hole where nobody is looking.
 *
 * Measured 2026-08-27: rclone installed, /etc/nexus-backup.env present, both
 * values EMPTY, and every night since the feature was written printing
 * "Off-box copy: SKIPPED" to that file. Half-configured, silent, for weeks.
 */
const backupUnprotected: Operator = {
  slug: "backup-unprotected",
  title: "The database backup is not protecting what it should",
  description:
    "The nightly dump has stopped, failed, or is not leaving this machine. Losing the server would lose the database and every backup of it together, and nothing else on this platform would have mentioned it.",
  run: async (organizationId) => {
    // Not per business. `backup_runs` belongs to no tenant -- a backup is of
    // the whole database -- and it is raised per business for the same reason
    // schedule-stalled is: the CONSEQUENCE is each business losing its own
    // customers, so it belongs where the person responsible for them looks.
    const { rows } = await getPool().query<{
      ran_at: string;
      verified: boolean;
      off_box: boolean;
      failed_reason: string | null;
    }>(
      `select ran_at, verified, off_box, failed_reason
         from backup_runs
        order by ran_at desc
        limit 1`
    );

    const latest = rows[0];

    // SILENCE UNTIL THERE IS SOMETHING TO SAY.
    //
    // The table is empty on the day this ships and stays empty until 03:15,
    // and backups have been running correctly the whole time. Reporting "no
    // backup" from an absence of ROWS would be reporting on the recording
    // rather than on the backup -- the same mistake as calling a job stalled
    // ninety seconds after the worker booted.
    if (!latest) return [];

    const hours = Math.round((Date.now() - new Date(latest.ran_at).getTime()) / 3_600_000);
    const out: FindingInput[] = [];

    if (latest.failed_reason) {
      out.push({
        // One fingerprint per condition, not per run: a backup failing every
        // night for a week is one problem, and a new finding each morning
        // would bury the six other operators under it.
        fingerprint: `${organizationId}:backup-failed`,
        // The subject is the BUSINESS, not the run. A finding keyed on a
        // run could never be retracted once that run scrolled out of view,
        // and the deck links a finding by its subject.
        subjectKind: "organization",
        subjectId: organizationId,
        severity: "urgent",
        title: "Last night's backup failed",
        detail: `The backup run ${hours}h ago did not complete: "${latest.failed_reason}". Until it succeeds there is no new copy of the database, and the older ones are only kept for a fortnight.`,
      });
    } else if (hours > BACKUP_STALE_HOURS) {
      out.push({
        fingerprint: `${organizationId}:backup-stale`,
        // The subject is the BUSINESS, not the run. A finding keyed on a
        // run could never be retracted once that run scrolled out of view,
        // and the deck links a finding by its subject.
        subjectKind: "organization",
        subjectId: organizationId,
        severity: "urgent",
        title: `No backup has run for ${hours} hours`,
        detail:
          "The dump is scheduled nightly at 03:15. Missing a night usually means cron was removed, the disk is full, or the database refused the dump — and the platform carries on answering customers either way, which is what makes this quiet.",
      });
    }

    // AN OWNER MAY DECIDE THIS, AND A DECIDED THING IS NOT A FINDING.
    //
    // On 2026-08-27 the owner chose to keep backups on the machine only. That is
    // theirs to choose, and five findings that can never clear would be exactly
    // the permanent noise this deck argues against everywhere else -- the
    // fastest way to teach somebody that a warn badge means nothing.
    //
    // NOT deleted, and not a dismissal either. The dismissal horizons have no
    // "forever" on purpose, because a standing business decision is a different
    // thing from "remind me later" and should be written down where the next
    // person reads it rather than buried in a mute. So it is an explicit env
    // flag: greppable, dated in .env, and off by default so a NEW deployment is
    // still told.
    //
    // backup-check still prints "NOT off-box" on every run regardless. The
    // decision silences the nag, never the fact.
    const offsiteWaived = process.env.BACKUP_OFFSITE_WAIVED === "1";

    // Reported even when the run succeeded, because a verified dump sitting on
    // the machine it protects is the case this whole operator was written for.
    if (!latest.off_box && !latest.failed_reason && !offsiteWaived) {
      out.push({
        fingerprint: `${organizationId}:backup-not-off-box`,
        // The subject is the BUSINESS, not the run. A finding keyed on a
        // run could never be retracted once that run scrolled out of view,
        // and the deck links a finding by its subject.
        subjectKind: "organization",
        subjectId: organizationId,
        severity: "warn",
        title: "Backups are not leaving this machine",
        detail:
          "The nightly dump restores cleanly and is kept in /opt/nexus/backups — on the same disk as the database it protects. Losing the server loses both. Set BACKUP_REMOTE and BACKUP_PASSPHRASE in /etc/nexus-backup.env; rclone is already installed.",
      });
    }

    return out;
  },
};


/** A probe every fifteen minutes; two missed in a row is a gap worth naming. */
const PROBE_STALE_MINUTES = 45;

/**
 * Whether anything outside the containers could reach this platform.
 *
 * `serving-check` is the only gate that asks from outside -- it calls the public
 * hostnames, so Caddy, TLS and DNS are all in the path -- and until now it asked
 * only when a person ran verify-all.sh. Between deploys that is nobody, for
 * days. A wedged api container or a certificate that expired overnight would be
 * found by the next release, while every customer message went unanswered.
 *
 * It runs from cron every fifteen minutes now and records what it saw. This
 * reads the last row.
 *
 * WHAT IT CANNOT SAY. The probe runs on the same machine, so "outside" means
 * outside the containers, not outside the building. Nothing running on a box
 * can report that the box is gone. That case still needs a monitor somewhere
 * else and this does not stand in for one -- which is why a stale probe is
 * reported rather than treated as silence.
 */
const unreachableFromOutside: Operator = {
  slug: "unreachable-from-outside",
  title: "The platform could not be reached from outside",
  description:
    "A probe calls the public hostnames every fifteen minutes, the way a customer's phone and the operator console do. This reports when that stopped working, or stopped running.",
  run: async (organizationId) => {
    // Not per business, and raised per business for the same reason
    // schedule-stalled is: reachability belongs to no tenant, and the
    // consequence -- every customer of that business going unanswered -- lands
    // on each of them separately.
    const { rows } = await getPool().query<{
      ran_at: string;
      ok: boolean;
      waited_ms: number | null;
      detail: string | null;
    }>(
      `select ran_at, ok, waited_ms, detail
         from outside_probes
        order by ran_at desc
        limit 1`
    );

    const latest = rows[0];

    // Silence until the first probe. The table is empty between this shipping
    // and the next quarter-hour, and the platform is reachable throughout --
    // reporting from an absence of rows would be reporting on the recording.
    if (!latest) return [];

    const minutes = Math.round((Date.now() - new Date(latest.ran_at).getTime()) / 60_000);

    if (!latest.ok) {
      return [
        {
          fingerprint: `${organizationId}:unreachable`,
          subjectKind: "organization",
          subjectId: organizationId,
          severity: "urgent",
          title: "Customers cannot reach this platform",
          detail: `The last check ${minutes} minutes ago could not get an answer from the public hostnames (${latest.detail ?? "no detail recorded"}). Messages are not being answered and the console will not load. Check the containers and the certificate before anything else on this page.`,
        },
      ];
    }

    if (minutes > PROBE_STALE_MINUTES) {
      return [
        {
          fingerprint: `${organizationId}:probe-stopped`,
          subjectKind: "organization",
          subjectId: organizationId,
          severity: "warn",
          title: `Nothing has checked the platform from outside for ${minutes} minutes`,
          detail:
            "The probe runs every fifteen minutes from cron. Missing several in a row usually means the cron entry was removed or the host is under load — and while it is not running, an outage would be invisible again. It says nothing about whether the platform is up right now.",
        },
      ];
    }

    return [];
  },
};

export const OPERATORS: Operator[] = [
  customerWaiting,
  agentUnavailable,
  scheduleStalled,
  // Sits beside scheduleStalled because they split one question between them:
  // that one watches for work that stops, this one for work that throws and
  // carries on. Neither sees the other's case.
  jobFailing,
  handoverAbandoned,
  deliveryFailing,
  retrievalUnavailable,
  intentClassificationStopped,
  overdueFollowUp,
  unownedFollowUp,
  brokenKnowledge,
  // Beside brokenKnowledge because they divide one question: that one asks
  // whether a source FAILED, this one whether the ones that succeeded are
  // still current. A page can be perfectly indexed and a week out of date.
  knowledgeNotRefreshing,
  thinKnowledge,
  judgeOffline,
  procedureAwaitingReview,
  wordingAwaitingReview,
  procedureSwitchedOn,
  backupUnprotected,
  unreachableFromOutside,
  bookingWithoutAnyone,
  bookingUnassigned,
  accountStanding,
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
  // BEFORE THE LOOP, and that is the whole point -- see SweepContext. Once
  // inside withTenant this read returns one business's staff and looks fine.
  // Both read outside any tenant transaction, and both read ONCE. The standing
  // call reaches Meta, so a failure here must not take the sweep down with it:
  // every other operator still has work to do when WhatsApp is unreachable.
  const sweep: SweepContext = {
    staffNumbers: await staffWhatsAppNumbers(),
    numberStanding: await readSharedNumberStanding(),
  };
  const summaries: OperatorRunSummary[] = [];

  // Collected across the whole sweep and dispatched once at the end, not per
  // operator. Sixteen operators times five businesses is eighty chances to
  // notify somebody; a bad ten minutes should be one message, not eighty.
  const raisedThisSweep: RaisedFinding[] = [];
  const slugById = new Map(organizations.map((o) => [o.id, o.slug]));

  for (const organization of organizations) {
    for (const operator of OPERATORS) {
      try {
        const summary = await withTenant(organization.id, async () => {
          const found = await operator.run(organization.id, sweep);
          const result = await reconcileFindings(organization.id, operator.slug, found);
          return result;
        });
        raisedThisSweep.push(...summary.raised);
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

  // AFTER the sweep, and outside its error handling on purpose. Every finding
  // is already written and visible on the deck by this point, so a dead webhook
  // costs a log line and nothing else -- it must never be the reason an operator
  // run is recorded as failed.
  await dispatchRaisedFindings(raisedThisSweep, (id) => slugById.get(id) ?? id);

  // THE HANDS, after the eyes have finished. Every finding is written by this
  // point, so the automations read what is true rather than what is arriving,
  // and a business with no automations does one cheap query and stops.
  //
  // Deliberately not given `raisedThisSweep`: that list carries no subject, on
  // purpose, because it is built for dispatch OUTSIDE the platform and a
  // finding's title names a customer. The runner reads the findings itself,
  // scoped to each business.
  //
  // Outside the sweep's error handling for the same reason the dispatch is: an
  // automation that throws must never be the reason an operator run is recorded
  // as failed, because the findings themselves are correct and already visible.
  await runAutomations(organizations.map((organization) => organization.id)).catch((err) => {
    logger.error({ err }, "Automations failed — every finding still stands and is on the deck");
  });

  return summaries;
}
