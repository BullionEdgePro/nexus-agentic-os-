import { getPool } from "./client.js";

/**
 * How fast each person answers — DoubleTick's team performance report.
 *
 * ============================================================
 * WHAT IS BEING TIMED
 * ============================================================
 *
 * A human reply is timed from the customer message it ANSWERS: the earliest
 * inbound message after our previous outbound one (anyone's — the AI's
 * included). So:
 *
 *   - A reply to a customer who had been waiting counts, with the wait.
 *   - A second message from us in a row, or a reply after the AI had already
 *     answered, is a reply but not a response — nobody was waiting on it — and
 *     it is counted as sent without dragging the average about.
 *
 * Only `human_agent` rows. The AI's own replies carry the ASSIGNED employee in
 * employee_id, so reading employee_id without the sender_type filter would
 * credit a person with the machine's speed.
 *
 * ============================================================
 * WHO SENT IT
 * ============================================================
 *
 * coalesce(employee_id, sender_id): a reply from a staff member's own phone
 * (recordOutboundEcho) carries employee_id; a reply typed in the inbox carries
 * sender_id — the employee's id, or an admin's. Inbox replies were not
 * attributed at all before the 2026-09-28 inbox work, so older ones come back
 * with no sender and are reported as such rather than dropped: a total that
 * quietly shrinks is worse than one that says why part of it has no name.
 *
 * Scoped by messages.serving_organization_id (migration 054) — the business the
 * customer was talking to, which on the shared number is not the row's owner.
 */
export interface StaffResponseTime {
  /** Employee or admin id as text; null for replies sent before attribution existed. */
  staffId: string | null;
  name: string;
  /** Business the person belongs to, when they are an employee. */
  organizationName: string | null;
  repliesSent: number;
  /** Replies that answered a customer who was waiting. */
  responses: number;
  medianSeconds: number | null;
  averageSeconds: number | null;
  /** Of `responses`, how many came within the target. */
  withinTarget: number;
  slowestSeconds: number | null;
}

export async function getStaffResponseTimes(
  organizationId: string | null,
  days: number,
  targetMinutes: number
): Promise<StaffResponseTime[]> {
  const { rows } = await getPool().query<{
    staff_id: string | null;
    name: string | null;
    organization_name: string | null;
    replies_sent: string;
    responses: string;
    median_s: number | null;
    average_s: number | null;
    within_target: string;
    slowest_s: number | null;
  }>(
    `with replies as (
       select coalesce(m.employee_id::text, m.sender_id) as staff_id,
              m.created_at,
              (select min(i.created_at)
                 from messages i
                where i.conversation_id = m.conversation_id
                  and i.direction = 'inbound'
                  and i.created_at <= m.created_at
                  and i.created_at > coalesce(
                        (select max(o.created_at) from messages o
                          where o.conversation_id = m.conversation_id
                            and o.direction = 'outbound'
                            and o.created_at < m.created_at
                            and o.id <> m.id),
                        '-infinity'::timestamptz)
              ) as asked_at
         from messages m
        where m.direction = 'outbound'
          and m.sender_type = 'human_agent'
          and m.created_at > now() - ($2::int * interval '1 day')
          and ($1::uuid is null or m.serving_organization_id = $1::uuid)
     ), timed as (
       select staff_id,
              extract(epoch from (created_at - asked_at))::float8 as wait_s
         from replies
     )
     select t.staff_id,
            coalesce(e.full_name, a.full_name) as name,
            o.name as organization_name,
            count(*)::text as replies_sent,
            count(t.wait_s)::text as responses,
            percentile_cont(0.5) within group (order by t.wait_s) filter (where t.wait_s is not null) as median_s,
            avg(t.wait_s) as average_s,
            count(*) filter (where t.wait_s is not null and t.wait_s <= $3::int * 60)::text as within_target,
            max(t.wait_s) as slowest_s
       from timed t
       left join employees e on e.id::text = t.staff_id
       left join admins a on a.id::text = t.staff_id
       left join organizations o on o.id = e.organization_id
      group by t.staff_id, e.full_name, a.full_name, o.name
      order by count(t.wait_s) desc, count(*) desc`,
    [organizationId, days, targetMinutes]
  );

  return rows.map((r) => ({
    staffId: r.staff_id,
    name: r.name ?? (r.staff_id ? "An administrator" : "Not attributed (sent before 28 Sep)"),
    organizationName: r.organization_name,
    repliesSent: Number(r.replies_sent),
    responses: Number(r.responses),
    medianSeconds: r.median_s == null ? null : Math.round(Number(r.median_s)),
    averageSeconds: r.average_s == null ? null : Math.round(Number(r.average_s)),
    withinTarget: Number(r.within_target),
    slowestSeconds: r.slowest_s == null ? null : Math.round(Number(r.slowest_s)),
  }));
}
