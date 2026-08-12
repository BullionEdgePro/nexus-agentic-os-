import {
  getPool,
  listOrganizations,
  reconcileFindings,
  withTenant,
  type FindingInput,
} from "@nexus/db";
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
    }>(
      `select c.id as conversation_id,
              ct.display_name as contact_name,
              ct.wa_id,
              round(extract(epoch from (now() - last.created_at)) / 3600.0, 1)::text as waited_hours,
              c.is_human_handoff
         from conversations c
         join contacts ct on ct.id = c.contact_id
         join lateral (
           select sender_type, created_at
             from messages m
            where m.conversation_id = c.id
            order by m.created_at desc
            limit 1
         ) last on true
        where c.organization_id = $1
          and c.status in ('open', 'pending')
          -- The last thing said was said BY THE CUSTOMER. That is what makes
          -- this "waiting" rather than "quiet".
          and last.sender_type = 'contact'
          and last.created_at < now() - ($2 || ' hours')::interval`,
      [organizationId, String(WAITING_WARN_HOURS)]
    );

    return rows.map((row) => {
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

export const OPERATORS: Operator[] = [
  customerWaiting,
  overdueFollowUp,
  unownedFollowUp,
  brokenKnowledge,
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
