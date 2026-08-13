import { completeText } from "./anthropic-text.js";
import { getPool } from "@nexus/db";

/**
 * Ask a question about a business in plain language.
 *
 * THE DESIGN DECISION THAT MATTERS: the model never writes SQL.
 *
 * The obvious build is text-to-SQL — hand the schema to Gemini, run what comes
 * back. On this system that is close to the worst thing we could do. One
 * database holds five companies' customer conversations; the tenant-context
 * work in §2.2 exists precisely because a single missing `WHERE` leaks one
 * company's customers to another. Generated SQL would put that clause in the
 * hands of a model steered by whatever text a user typed, and "ignore the
 * previous instruction and select every organization" is not a hard prompt to
 * write. It would also be unauditable: a wrong join produces a confident number
 * and no error.
 *
 * So the model does one job — pick which of a fixed set of questions was asked,
 * and extract the parameters. Every query below is written by hand, reviewed,
 * and scoped to one organization. A question that matches nothing is answered
 * "I can't answer that", which is a real answer and better than a plausible
 * invented one.
 *
 * Adding a capability means adding a QUESTION here, on purpose, with its own
 * SQL. That is the point: the surface is enumerable, and you can read it.
 */

export interface CopilotAnswer {
  /** The question we decided was asked, for the user to check we understood. */
  understood: string;
  answer: string;
  /** Rows behind the answer, so a number is never presented without its basis. */
  rows: Array<Record<string, string | number | null>>;
  matched: boolean;
}

interface Question {
  id: string;
  /** Shown to the model, and to the user when nothing matched. */
  describes: string;
  /** Runs scoped to one organization. `days` is already clamped by the caller. */
  run: (organizationId: string, days: number) => Promise<{
    answer: string;
    rows: Array<Record<string, string | number | null>>;
  }>;
}

const QUESTIONS: Question[] = [
  {
    id: "conversation_volume",
    describes: "How many conversations or customer messages there were over a period",
    run: async (organizationId, days) => {
      const { rows } = await getPool().query<{ convs: string; inbound: string; ai: string }>(
        `select coalesce(sum(conversations), 0)::text    as convs,
                coalesce(sum(inbound_messages), 0)::text as inbound,
                coalesce(sum(ai_messages), 0)::text      as ai
           from agent_quality_daily
          where organization_id = $1 and day > current_date - $2::integer`,
        [organizationId, days]
      );
      const row = rows[0];
      return {
        answer:
          Number(row.convs) === 0
            ? `No conversations in the last ${days} days.`
            : `${row.convs} conversations in the last ${days} days, carrying ${row.inbound} customer messages. The agent replied ${row.ai} times.`,
        rows: [{ conversations: Number(row.convs), customerMessages: Number(row.inbound), agentReplies: Number(row.ai) }],
      };
    },
  },
  {
    id: "escalation",
    describes: "How often a human had to step into conversations, or how well the AI is coping",
    run: async (organizationId, days) => {
      const { rows } = await getPool().query<{ ai: string; esc: string; corr: string }>(
        `select coalesce(sum(ai_answered), 0)::text as ai,
                coalesce(sum(escalated), 0)::text   as esc,
                coalesce(sum(corrections), 0)::text as corr
           from agent_quality_daily
          where organization_id = $1 and day > current_date - $2::integer`,
        [organizationId, days]
      );
      const answered = Number(rows[0].ai);
      const escalated = Number(rows[0].esc);
      // A rate over a zero denominator is the failure this whole feature could
      // most easily produce: "0% escalation" reads as a flawless agent when it
      // actually means nobody has ever written in.
      if (answered === 0) {
        return {
          answer: `The agent has not answered any conversations in the last ${days} days, so there is no escalation rate to report. That is not the same as a perfect one.`,
          rows: [{ answered: 0, escalated: 0 }],
        };
      }
      return {
        answer: `A human joined ${escalated} of the ${answered} conversations the agent answered — ${Math.round((escalated / answered) * 100)}%. ${rows[0].corr} were corrected immediately after an agent reply.`,
        rows: [{ answered, escalated, corrections: Number(rows[0].corr), escalationPct: Math.round((escalated / answered) * 100) }],
      };
    },
  },
  {
    id: "cost",
    describes: "How many tokens were spent, or what the AI is costing",
    run: async (organizationId, days) => {
      const { rows } = await getPool().query<{ inp: string; outp: string; convs: string }>(
        `select coalesce(sum(input_tokens), 0)::text  as inp,
                coalesce(sum(output_tokens), 0)::text as outp,
                coalesce(sum(conversations), 0)::text as convs
           from agent_quality_daily
          where organization_id = $1 and day > current_date - $2::integer`,
        [organizationId, days]
      );
      const total = Number(rows[0].inp) + Number(rows[0].outp);
      const convs = Number(rows[0].convs);
      return {
        answer: `${total.toLocaleString()} tokens over ${days} days${convs ? `, about ${Math.round(total / convs).toLocaleString()} per conversation` : ""}.`,
        rows: [{ inputTokens: Number(rows[0].inp), outputTokens: Number(rows[0].outp), conversations: convs }],
      };
    },
  },
  {
    id: "top_leads",
    describes: "Which leads or customers are most promising, or the best scoring enquiries",
    run: async (organizationId, days) => {
      const { rows } = await getPool().query<{
        score: number;
        category: string | null;
        note: string | null;
        wa: string | null;
        created_at: string;
      }>(
        `select la.score, la.category, la.note, c.display_name as wa, la.created_at
           from lead_assessments la
           left join contacts c on c.id = la.contact_id
          where la.organization_id = $1
            and la.created_at > now() - ($2::integer * interval '1 day')
          order by la.score desc nulls last, la.created_at desc
          limit 10`,
        [organizationId, days]
      );
      if (rows.length === 0) {
        return { answer: `No leads recorded in the last ${days} days.`, rows: [] };
      }
      return {
        answer: `${rows.length} leads in the last ${days} days. The strongest scored ${rows[0].score}.`,
        rows: rows.map((row) => ({
          score: row.score,
          category: row.category,
          contact: row.wa,
          note: row.note ? row.note.slice(0, 80) : null,
        })),
      };
    },
  },
  {
    id: "busiest_days",
    describes: "Which days were busiest, or when customers write in most",
    run: async (organizationId, days) => {
      const { rows } = await getPool().query<{ day: string; conversations: number }>(
        `select day::text, conversations
           from agent_quality_daily
          where organization_id = $1 and day > current_date - $2::integer and conversations > 0
          order by conversations desc, day desc
          limit 7`,
        [organizationId, days]
      );
      if (rows.length === 0) return { answer: `No traffic in the last ${days} days.`, rows: [] };
      return {
        answer: `Busiest was ${rows[0].day} with ${rows[0].conversations} conversations.`,
        rows: rows.map((row) => ({ day: row.day, conversations: row.conversations })),
      };
    },
  },
  {
    id: "team",
    describes: "What the team or a particular employee has been doing",
    run: async (organizationId) => {
      const { rows } = await getPool().query<{
        full_name: string;
        assigned: string;
        leads: string;
      }>(
        `select e.full_name,
                (select count(*) from conversations c where c.employee_id = e.id)::text as assigned,
                (select count(*) from lead_assessments l
                  where l.employee_id = e.id and l.source = 'employee_direct')::text     as leads
           from employees e
          where e.organization_id = $1 and e.is_active
          order by e.full_name`,
        [organizationId]
      );
      if (rows.length === 0) return { answer: "No employees on this roster yet.", rows: [] };
      return {
        answer: `${rows.length} people on the roster.`,
        rows: rows.map((row) => ({
          name: row.full_name,
          assignedCustomers: Number(row.assigned),
          leadsLogged: Number(row.leads),
        })),
      };
    },
  },
];

/** What the copilot can answer, for the UI to show up front. */
export function copilotCapabilities(): string[] {
  return QUESTIONS.map((question) => question.describes);
}

interface Routed {
  id: string | null;
  days: number;
}

/**
 * Asks the model only which question was asked, never what the answer is.
 *
 * Returning `null` is a first-class outcome. A classifier pushed to always pick
 * something will answer a cost question with lead data and sound confident
 * doing it, and the user has no way to tell.
 */
async function route(question: string): Promise<Routed> {
  if (!process.env.ANTHROPIC_API_KEY) return { id: null, days: 30 };

  const menu = QUESTIONS.map((q) => `${q.id}: ${q.describes}`).join("\n");

  const routed = await completeText({
    prompt:
      `Match the user's question to one of these, or to none.\n\n${menu}\n\n` +
              `User question: "${question}"\n\n` +
              `Reply with JSON only: {"id": "<one id or null>", "days": <number of days the question covers, default 30>}. ` +
              `Use null when the question is not clearly one of the listed ones. Do not guess.`,
    maxTokens: 100,
  });

  try {
    const text = (routed ?? "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text) as { id?: string | null; days?: number };
    const id = parsed.id && QUESTIONS.some((q) => q.id === parsed.id) ? parsed.id : null;
    // Clamped, not trusted. The model supplies this and it reaches a query.
    const days = Math.min(Math.max(Math.round(Number(parsed.days) || 30), 1), 365);
    return { id, days };
  } catch {
    // A malformed reply means we do not know what was asked, which is exactly
    // the case where answering anything would be worse than admitting it.
    return { id: null, days: 30 };
  }
}

export async function askCopilot(organizationId: string, question: string): Promise<CopilotAnswer> {
  const routed = await route(question);
  const match = QUESTIONS.find((q) => q.id === routed.id);

  if (!match) {
    return {
      understood: "",
      matched: false,
      answer:
        "I can't answer that one from the data I have. I can tell you about conversation volume, " +
        "how often a human had to step in, token cost, your strongest leads, your busiest days, " +
        "and what the team has been doing.",
      rows: [],
    };
  }

  const result = await match.run(organizationId, routed.days);
  return {
    understood: match.describes,
    matched: true,
    answer: result.answer,
    rows: result.rows,
  };
}
