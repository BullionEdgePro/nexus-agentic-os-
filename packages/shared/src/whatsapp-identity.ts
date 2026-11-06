/**
 * Who a WhatsApp message is from, or to (6 Nov 2026).
 *
 * WhatsApp lets people use a username instead of showing their number. Meta
 * then identifies them by a business-scoped user id (BSUID): the ISO country
 * code, a dot, and up to 128 letters and digits — "AE.13491208655302741918", or
 * "US.ENT.11815799212886844830" for a parent id. A message from such a person
 * has no `from` at all, only `from_user_id`; an echo to them, no `to` but
 * `to_user_id`. Everything in Nexus read `from` as the customer's number, and a
 * customer with a username was lost (5 Nov 2026, five retries on the contacts
 * identity check).
 *
 * So a customer is their number when Meta gives one (or once gave it with the
 * same BSUID — apps/api/src/lib/whatsapp-customer.ts), and their BSUID when
 * not. The BSUID is stored where the number would be (`contacts.wa_id`), and a
 * send to it goes in Meta's `recipient` field rather than `to`.
 */

const BUSINESS_SCOPED_USER_ID = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;

/** Whether this WhatsApp address is a BSUID rather than a phone number. */
export function isBusinessScopedUserId(id: string): boolean {
  return BUSINESS_SCOPED_USER_ID.test(id);
}

/**
 * How a customer's WhatsApp address reads on screen: "+971…" for a number, and
 * "WhatsApp username" for a business-scoped id — printed as a number it read
 * "+AE.1349…", which is no number anybody can dial.
 */
export function whatsAppAddressLabel(waId: string): string {
  return isBusinessScopedUserId(waId) ? "WhatsApp username" : `+${waId}`;
}
