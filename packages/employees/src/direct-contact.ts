import type { Employee } from "@nexus/shared";

/**
 * Reduce a written phone number to the digits WhatsApp expects.
 *
 * WhatsApp's click-to-chat links take an international number with no `+`, no
 * spaces and no punctuation — `971501234567`, never `+971 50 123 4567`. People
 * type numbers every other way, so this normalises rather than rejecting.
 *
 * Returns null instead of a best guess when the result cannot be a real
 * international number. A malformed link does not fail loudly: WhatsApp opens
 * and says the number is invalid, which the employee reads as "this customer
 * isn't on WhatsApp" rather than "we stored a bad number". Refusing to build
 * the link at all is the honest failure.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let digits = raw.trim();
  // `00` is the international prefix in most of the world and `+` is its
  // shorthand; both mean "what follows is a country code".
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);

  digits = digits.replace(/\D+/g, "");

  // E.164 allows at most 15 digits. The lower bound is deliberately loose —
  // short national numbers exist — but anything under 8 cannot carry a country
  // code and a subscriber number.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export interface DirectContactInput {
  employee: Pick<Employee, "fullName" | "jobTitle" | "whatsappNumber">;
  businessName: string;
  customerWaId: string;
  customerName?: string | null;
}

export interface DirectContact {
  /** Opens the customer's chat in whatever WhatsApp account the employee is signed into. */
  url: string;
  /** The pre-filled first message. The employee can edit it before sending. */
  message: string;
  /** The number the employee says they message from, for display. Null if unset. */
  sendingAs: string | null;
}

/**
 * Build the link an employee taps to continue a conversation from their own
 * WhatsApp account.
 *
 * Why a click-to-chat link rather than another Business API number: every WABA
 * number costs money, needs Meta approval and has to be onboarded one at a
 * time. Employees already carry a phone with WhatsApp on it. This gives each of
 * them a direct line to their assigned customers on day one, with no per-person
 * infrastructure — the CRM number stays the single front door, and personal
 * numbers handle the follow-up.
 *
 * The trade-off is real and worth naming: messages sent this way happen outside
 * the platform. They are not logged, not governed, and not visible in the deck.
 * That is why taking a conversation to a personal number also puts it into human
 * handoff — see the route that calls this. A customer being answered by an AI on
 * one number and a person on another, neither aware of the other, is the failure
 * this is shaped to avoid.
 *
 * The opening message carries the introduction rather than leaving it to the
 * employee, because the customer is about to receive a message from a number
 * they have never seen. Without a name, a role and the business, that reads as
 * spam — which is the difference between a warm handoff and a blocked contact.
 */
export function buildDirectContact(input: DirectContactInput): DirectContact | null {
  const customer = normalizeWhatsAppNumber(input.customerWaId);
  if (!customer) return null;

  const greeting = input.customerName ? `Hello ${input.customerName}` : "Hello";
  const role = input.employee.jobTitle ? ` (${input.employee.jobTitle})` : "";

  const message =
    `${greeting} — this is ${input.employee.fullName}${role} from ${input.businessName}. ` +
    `I'm picking up your enquiry from our WhatsApp, and you can reply to me directly on this number from now on.`;

  return {
    url: `https://wa.me/${customer}?text=${encodeURIComponent(message)}`,
    message,
    sendingAs: normalizeWhatsAppNumber(input.employee.whatsappNumber),
  };
}
