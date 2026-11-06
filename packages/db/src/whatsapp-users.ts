import { getPool, acrossEveryBusiness } from "./client.js";

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
 * Keep a BSUID and its number, as Meta sent them together. A customer first
 * known only by BSUID now has a number: their contact takes it, in each
 * business that does not already have a contact under that number — so the
 * chat they started under their username continues under their number.
 */
export async function rememberWhatsAppUser(userId: string, waId: string): Promise<void> {
  await acrossEveryBusiness("whatsapp: a username id's number, learnt from Meta", async () => {
    const learnt = await getPool().query(
      `insert into whatsapp_user_ids (user_id, wa_id) values ($1, $2)
       on conflict (user_id) do update set wa_id = excluded.wa_id, learnt_at = now()
        where whatsapp_user_ids.wa_id is distinct from excluded.wa_id`,
      [userId, waId]
    );
    // Only when the pair is new or changed: every later message carries the
    // same pair, and the contacts need moving once.
    if (learnt.rowCount === 0) return;
    await getPool().query(
      `update contacts c set wa_id = $2, updated_at = now()
        where c.wa_id = $1
          and not exists (select 1 from contacts d where d.organization_id = c.organization_id and d.wa_id = $2)`,
      [userId, waId]
    );
  });
}
