import { getPool } from "./client.js";

/**
 * What each employee has actually been doing.
 *
 * Built for the question an owner really asks — "what is my team doing?" — from
 * the traces the platform already keeps, rather than by adding surveillance.
 * Every number here is a side effect of work that had to be recorded anyway:
 * conversations assigned, leads logged, handoffs taken, sign-ins.
 *
 * Worth being straight about the limits, because a dashboard that looks
 * complete invites conclusions it cannot support:
 *
 *   * Messages an employee sends from their OWN phone are invisible. That is
 *     the deliberate trade of not buying a WhatsApp number per person — the
 *     handoff is recorded, the conversation that follows is not.
 *   * "Assigned" counts responsibility, not effort. A quiet employee with ten
 *     assigned customers may be doing more than a busy one with two.
 *
 * `lastActiveAt` is the most recent of anything they did, so "no activity" is
 * distinguishable from "never signed in".
 */
export interface EmployeeActivity {
  employeeId: string;
  fullName: string;
  jobTitle: string | null;
  organizationSlug: string;
  organizationName: string;
  isActive: boolean;
  hasSignIn: boolean;
  lastLoginAt: string | null;
  assignedConversations: number;
  /** Of those, the ones a human has taken over. */
  handoffs: number;
  leadsLogged: number;
  bestLeadScore: number | null;
  lastLeadAt: string | null;
  lastActiveAt: string | null;
}

export async function getEmployeeActivity(organizationId?: string | null): Promise<EmployeeActivity[]> {
  const { rows } = await getPool().query<{
    employee_id: string;
    full_name: string;
    job_title: string | null;
    slug: string;
    org_name: string;
    is_active: boolean;
    has_sign_in: boolean;
    last_login_at: string | null;
    assigned_conversations: string;
    handoffs: string;
    leads_logged: string;
    best_lead_score: number | null;
    last_lead_at: string | null;
  }>(
    `select e.id                          as employee_id,
            e.full_name,
            e.job_title,
            o.slug,
            o.name                        as org_name,
            e.is_active,
            (e.access_code_hash is not null) as has_sign_in,
            e.last_login_at,
            coalesce(c.total, 0)::text    as assigned_conversations,
            coalesce(c.handoffs, 0)::text as handoffs,
            coalesce(l.total, 0)::text    as leads_logged,
            l.best_score                  as best_lead_score,
            l.last_at                     as last_lead_at
       from employees e
       join organizations o on o.id = e.organization_id
       -- Aggregated in subqueries rather than joined directly: joining both
       -- tables and grouping would multiply conversation rows by lead rows and
       -- silently inflate every count.
       left join (
         select employee_id,
                count(*)                                        as total,
                count(*) filter (where is_human_handoff)         as handoffs
           from conversations
          where employee_id is not null
          group by employee_id
       ) c on c.employee_id = e.id
       left join (
         select employee_id,
                count(*)          as total,
                max(score)        as best_score,
                max(created_at)   as last_at
           from lead_assessments
          where employee_id is not null and source = 'employee_direct'
          group by employee_id
       ) l on l.employee_id = e.id
      where o.is_active
        and ($1::uuid is null or e.organization_id = $1)
      order by o.name asc, e.full_name asc`,
    [organizationId ?? null]
  );

  return rows.map((row) => {
    const lastLead = row.last_lead_at;
    const lastLogin = row.last_login_at;
    // The later of the two, treating nulls as "never" rather than as zero —
    // Date parsing a null yields 1970, which would make someone who has never
    // signed in look like they were last active during the Nixon administration.
    const lastActiveAt =
      lastLead && lastLogin ? (lastLead > lastLogin ? lastLead : lastLogin) : lastLead ?? lastLogin ?? null;

    return {
      employeeId: row.employee_id,
      fullName: row.full_name,
      jobTitle: row.job_title,
      organizationSlug: row.slug,
      organizationName: row.org_name,
      isActive: row.is_active,
      hasSignIn: row.has_sign_in,
      lastLoginAt: lastLogin,
      assignedConversations: Number(row.assigned_conversations),
      handoffs: Number(row.handoffs),
      leadsLogged: Number(row.leads_logged),
      bestLeadScore: row.best_lead_score,
      lastLeadAt: lastLead,
      lastActiveAt,
    };
  });
}

export interface ActivityEvent {
  at: string;
  employeeName: string | null;
  organizationSlug: string;
  kind: "lead" | "handoff";
  detail: string;
  score: number | null;
}

/**
 * A single timeline across every employee, newest first.
 *
 * The per-person totals answer "who is doing what"; this answers "what just
 * happened". Both come from the same rows.
 */
export async function getRecentActivity(limit = 40): Promise<ActivityEvent[]> {
  const { rows } = await getPool().query<{
    at: string;
    employee_name: string | null;
    slug: string;
    kind: string;
    detail: string;
    score: number | null;
  }>(
    `select la.created_at        as at,
            e.full_name          as employee_name,
            o.slug,
            'lead'               as kind,
            coalesce(nullif(left(la.note, 90), ''), la.category) as detail,
            la.score
       from lead_assessments la
       join organizations o on o.id = la.organization_id
       left join employees e on e.id = la.employee_id
      where la.source = 'employee_direct'
      order by la.created_at desc
      limit $1`,
    [limit]
  );

  return rows.map((row) => ({
    at: row.at,
    employeeName: row.employee_name,
    organizationSlug: row.slug,
    kind: row.kind as "lead" | "handoff",
    detail: row.detail,
    score: row.score,
  }));
}
