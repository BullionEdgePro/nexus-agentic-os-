import { getPool, withAllTenants } from "./client.js";

/**
 * WhatsApp numbers that were switched off at Meta (migration 094).
 *
 * A retired line cannot send. Every path that would otherwise fall back to a
 * business's shared number asks here first, so it can say plainly why nothing
 * went out instead of handing the person a Graph error about an unregistered
 * phone number.
 */
export async function isWhatsAppNumberRetired(phoneNumberId: string | null | undefined): Promise<boolean> {
  if (!phoneNumberId) return false;
  const { rows } = await getPool().query<{ one: number }>(
    `select 1 as one from retired_whatsapp_numbers where phone_number_id = $1`,
    [phoneNumberId]
  );
  return rows.length > 0;
}

/**
 * Where WhatsApp stands now that people answer on their own numbers: whether a
 * shared line was retired, and how many active staff have a number of their own.
 *
 * Cross-tenant on purpose — it is the owner's whole-platform view (the Channels
 * screen), and `employees` is tenant data. The review sandbox is left out: its
 * one "staff member" is Meta's App Reviewer, not someone who answers customers.
 */
export async function whatsAppStanding(): Promise<{
  retiredSharedNumber: { displayNumber: string | null; retiredAt: string } | null;
  staffWithOwnNumber: number;
  activeStaff: number;
}> {
  return withAllTenants("the owner's whole-platform WhatsApp standing", async () => {
    const [retired, staff] = await Promise.all([
      getPool().query<{ display_number: string | null; retired_at: string }>(
        `select r.display_number, r.retired_at
           from retired_whatsapp_numbers r
          where exists (select 1 from organizations o where o.whatsapp_phone_number_id = r.phone_number_id)
          order by r.retired_at desc
          limit 1`
      ),
      getPool().query<{ with_number: string; active: string }>(
        `select count(*) filter (where e.whatsapp_phone_number_id is not null)::text as with_number,
                count(*)::text as active
           from employees e
           join organizations o on o.id = e.organization_id
          where e.is_active and o.is_active and o.slug <> 'review-demo'`
      ),
    ]);
    const row = retired.rows[0];
    return {
      retiredSharedNumber: row
        ? { displayNumber: row.display_number, retiredAt: new Date(row.retired_at).toISOString() }
        : null,
      staffWithOwnNumber: Number(staff.rows[0]?.with_number ?? 0),
      activeStaff: Number(staff.rows[0]?.active ?? 0),
    };
  });
}
