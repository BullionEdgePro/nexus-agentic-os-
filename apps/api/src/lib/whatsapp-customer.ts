import { phoneForWhatsAppUser, rememberWhatsAppUser } from "@nexus/db";
import { logger } from "./logger.js";

/**
 * Who a WhatsApp customer is filed as (6 Nov 2026, migration 109).
 *
 * Meta names a customer by their number when it may, and always by their
 * business-scoped user id (BSUID) as well. A customer who uses a username can
 * arrive with the BSUID alone. Filed under whatever arrived, the same person
 * became two contacts the moment they switched a username on, or showed their
 * number after starting under one. So:
 *
 *  - number and BSUID together: the pair is kept, and the number is used;
 *  - number alone: the number;
 *  - BSUID alone: the number Meta once sent with it, else the BSUID itself.
 *
 * Never throws: a lookup that fails files the message under what Meta sent,
 * which is how it was filed before, rather than costing the message.
 */
export async function customerFiledAs(phone: string | null, userId: string | null): Promise<string | null> {
  if (phone && userId) {
    await rememberWhatsAppUser(userId, phone).catch((err) =>
      logger.warn({ err }, "Could not keep the number behind a WhatsApp username id")
    );
    return phone;
  }
  if (phone) return phone;
  if (!userId) return null;
  const known = await phoneForWhatsAppUser(userId).catch((err) => {
    logger.warn({ err }, "Could not look up the number behind a WhatsApp username id");
    return null;
  });
  return known ?? userId;
}

/** A non-empty string from Meta's payload, or null. */
export function given(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
