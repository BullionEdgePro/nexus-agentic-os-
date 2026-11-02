/**
 * The storefront's way in for a business that wants Nexus (spec
 * 2026-11-02-storefront-cream-design.md §2): WhatsApp to a number Nexus itself
 * answers, so the visitor meets the agent live.
 *
 * The number is a server setting, NEXUS_SALES_WHATSAPP, read per request by
 * app/page.tsx — so it can be filled in after a deploy with a restart. Until it
 * is set, or if what is set is not a phone number, every button writes to the
 * address the public pages already publish instead: never a dead link.
 */
export type SalesContact = { kind: "whatsapp" | "email"; href: string };

export const SALES_TEXT = "Hi Nexus, I'd like to see how it works for my business";

/** The contact address app/privacy, app/terms and app/data-deletion publish. */
export const CONTACT_EMAIL = "jurishostinger11@gmail.com";

export function salesContact(raw: string | undefined): SalesContact {
  // Accept the number the way a person types it: "+971 50 123 4567",
  // "971-50-1234567", "00971…". wa.me wants the bare international digits.
  const digits = (raw ?? "")
    .trim()
    .replace(/[\s\-.()]/g, "")
    .replace(/^(\+|00)/, "");
  if (/^\d{8,15}$/.test(digits)) {
    return { kind: "whatsapp", href: `https://wa.me/${digits}?text=${encodeURIComponent(SALES_TEXT)}` };
  }
  return {
    kind: "email",
    href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Nexus for my business")}`,
  };
}
