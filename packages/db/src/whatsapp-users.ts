import { getPool, acrossEveryBusiness, withAllTenants } from "./client.js";
import { getTenantContext } from "./tenant-context.js";

/**
 * A WhatsApp username id (BSUID) and the number behind it (6 Nov 2026,
 * migration 109).
 *
 * Meta sends a customer's BSUID on every message and their number only when it
 * may. A customer who switches a username on keeps the same BSUID, so the pair
 * learnt from any earlier message files their username-only messages under the
 * number — one contact, not two. Cross-business on purpose, with a stated
 * reason, like whatsappSendTokenForNumber: the processor knows only what Meta
 * sent, and a BSUID is already scoped by Meta to one business portfolio.
 */

/** The number behind this BSUID, when Meta has ever sent the two together. */
export async function phoneForWhatsAppUser(userId: string): Promise<string | null> {
  return acrossEveryBusiness("whatsapp: the number behind a username id", async () => {
    const { rows } = await getPool().query<{ wa_id: string }>(
      `select wa_id from whatsapp_user_ids where user_id = $1`,
      [userId]
    );
    return rows[0]?.wa_id ?? null;
  });
}

/**
 * Keep a BSUID and its number, as Meta sent them together, and bring the
 * customer's contacts into line: a contact first filed under the BSUID takes
 * the number — in each business that has no contact under the number yet — so
 * the chat started under a username continues under the number. Where the
 * business has both, they stay apart, and an opt-out given under the username
 * follows the person to the number.
 *
 * On EVERY pair, not only a new one (review, 6 Nov 2026): a username-only job
 * running alongside can make a contact under the BSUID just after the pair is
 * kept; the next message with both moves it. An index on contacts(wa_id) keeps
 * that cheap (migration 109).
 *
 * A write across every business, so it runs in a transaction of its own and
 * never inside one business's (review): a failure there would abort the
 * caller's transaction and lose its writes.
 */
export async function rememberWhatsAppUser(userId: string, waId: string): Promise<void> {
  if (getTenantContext()) {
    throw new Error("rememberWhatsAppUser runs outside a business's transaction, never inside one");
  }
  await withAllTenants("whatsapp: a username id's number, learnt from Meta", async () => {
    await getPool().query(
      `insert into whatsapp_user_ids (user_id, wa_id) values ($1, $2)
       on conflict (user_id) do update set wa_id = excluded.wa_id, learnt_at = now()
        where whatsapp_user_ids.wa_id is distinct from excluded.wa_id`,
      [userId, waId]
    );
    await getPool().query(
      `update contacts p set reengagement_opted_out = true, updated_at = now()
         from contacts b
        where b.wa_id = $1 and b.reengagement_opted_out
          and p.organization_id = b.organization_id and p.wa_id = $2 and not p.reengagement_opted_out`,
      [userId, waId]
    );
    await getPool().query(
      `update contacts c set wa_id = $2, updated_at = now()
        where c.wa_id = $1
          and not exists (select 1 from contacts d where d.organization_id = c.organization_id and d.wa_id = $2)`,
      [userId, waId]
    );
  });
}
