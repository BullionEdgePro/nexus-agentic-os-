import { phoneForWhatsAppUser, rememberWhatsAppUser } from "@nexus/db";
import { isBusinessScopedUserId } from "@nexus/shared";
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
 * Each value is checked for what it is first (review): stripped to digits,
 * "AE.1349…" passes for a number, and kept as a pair it would re-file the
 * customer under a number that does not exist. Never throws: a lookup that
 * fails files the message under what Meta sent, as before, rather than costing
 * the message.
 */
export async function customerFiledAs(phone: unknown, userId: unknown): Promise<string | null> {
  const number = phoneIn(phone);
  const id = userIdIn(userId) ?? userIdIn(phone);
  if (number && id) {
    await rememberWhatsAppUser(id, number).catch((err) =>
      logger.warn({ err }, "Could not keep the number behind a WhatsApp username id")
    );
    return number;
  }
  if (number) return number;
  if (id) {
    const known = await phoneForWhatsAppUser(id).catch((err) => {
      logger.warn({ err }, "Could not look up the number behind a WhatsApp username id");
      return null;
    });
    return known ?? id;
  }
  // Neither shape Meta documents: filed under what it sent, as before.
  return given(phone) ?? given(userId);
}

/** A non-empty string from Meta's payload, or null. */
export function given(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A phone number from Meta's payload, as digits — never a BSUID read as one. */
export function phoneIn(value: unknown): string | null {
  const raw = given(value);
  if (!raw || isBusinessScopedUserId(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 20 ? digits : null;
}

/** A BSUID from Meta's payload, or null. */
export function userIdIn(value: unknown): string | null {
  const raw = given(value);
  return raw && isBusinessScopedUserId(raw) ? raw : null;
}
