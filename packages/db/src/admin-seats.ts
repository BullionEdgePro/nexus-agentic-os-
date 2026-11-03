import { getPool, withTenant } from "./client.js";
import { findEmployeeById } from "./employees.js";
import type { Employee } from "@nexus/shared";

/**
 * An admin's seat in a business (migration 108, 3 Nov 2026).
 *
 * Every connection is filed under one person in one business, and an admin
 * belonged to none, so they could connect nothing. A seat is an ordinary staff
 * record linked to the admin account: every staff flow — WhatsApp Business,
 * Gmail, the business mailbox, TikTok — then works for the admin unchanged.
 *
 * Inside an admin's request the outer cross-business context is reused (a
 * nested withTenant is a no-op by design); called on its own, it opens the
 * business's.
 */

/**
 * A seat MADE for an admin (ensureAdminSeat's own insert), as opposed to a
 * working hire's record an admin was linked to. Only a made seat stays off the
 * auto-assignment rota; a linked hire keeps their place on it.
 */
export function isCreatedSeat(employee: { adminId?: string | null; employeeCode: string }): boolean {
  return !!employee.adminId && employee.employeeCode === `admin-${employee.adminId.slice(0, 8)}`;
}

/** The admin's seat in this business, or null when they have not connected anything here yet. */
export async function findAdminSeat(adminId: string, organizationId: string): Promise<Employee | null> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `select id from employees where organization_id = $1 and admin_id = $2 limit 1`,
      [organizationId, adminId]
    );
    return rows[0] ? findEmployeeById(rows[0].id) : null;
  });
}

/**
 * The admin's seat in this business, made the first time it is needed:
 *
 *   1. the record already linked to this admin;
 *   2. else the person's existing ACTIVE staff record here (same email, any
 *      case) that no other admin holds — linked, never duplicated, because
 *      an admin may already be on the team;
 *   3. else a new record: their name and email, "Admin", no working hours and
 *      no access code, so nobody signs in to it as staff.
 *
 * Two first connects at once both end on the same seat: the partial unique
 * index allows one per admin per business, and the losing insert reads the
 * winner's row.
 */
export async function ensureAdminSeat(
  admin: { id: string; fullName: string; email: string },
  organizationId: string
): Promise<Employee> {
  return withTenant(organizationId, async () => {
    const pool = getPool();
    const linked = await pool.query<{ id: string }>(
      `select id from employees where organization_id = $1 and admin_id = $2 limit 1`,
      [organizationId, admin.id]
    );
    let id = linked.rows[0]?.id;

    if (!id) {
      const adopted = await pool.query<{ id: string }>(
        `update employees set admin_id = $2, updated_at = now()
          where id = (
            select id from employees
             where organization_id = $1 and admin_id is null and is_active = true
               and lower(email) = lower($3)
             order by created_at
             limit 1
          )
          returning id`,
        [organizationId, admin.id, admin.email]
      );
      id = adopted.rows[0]?.id;
    }

    if (!id) {
      const made = await pool.query<{ id: string }>(
        `insert into employees (organization_id, employee_code, full_name, email, job_title, admin_id)
         values ($1, $2, $3, $4, 'Admin', $5)
         on conflict do nothing
         returning id`,
        [organizationId, `admin-${admin.id.slice(0, 8)}`, admin.fullName, admin.email, admin.id]
      );
      id = made.rows[0]?.id;
    }

    if (!id) {
      const raced = await pool.query<{ id: string }>(
        `select id from employees where organization_id = $1 and admin_id = $2 limit 1`,
        [organizationId, admin.id]
      );
      id = raced.rows[0]?.id;
    }

    const seat = id ? await findEmployeeById(id) : null;
    if (!seat) throw new Error("The admin's seat in this business could not be made.");
    return seat;
  });
}
