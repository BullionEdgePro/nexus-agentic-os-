/**
 * Is this email from a platform the business sells on or runs on, rather than
 * a customer? (24 Oct 2026, the owner: "Shopify, noon, Amazon, Google,
 * Marketplace treated as automated mail".)
 *
 * NOT DROPPED, MARKED. lib/mail-filter.ts drops what no person wrote; these
 * are different — Amazon's disbursement-appeals mail about the store's funds
 * arrives this way and must stay readable. So a platform sender is marked "not
 * a customer" as it arrives: visible in the inbox, never counted as waiting.
 *
 * Matched on the registrable DOMAIN, exactly or as a subdomain, never on a
 * name or a substring: "mailer.merchant.alart@gmail.com" calling itself
 * Shopify is a phishing lookalike, and "notshopify.com" is not Shopify. Those
 * are what the inbox's one-tap "Not a customer" is for.
 */
const PLATFORM_DOMAINS: readonly string[] = [
  "shopify.com",
  "noon.com",
  "amazon.com",
  "amazon.ae",
  "amazon.sa",
  "amazon.co.uk",
  "google.com",
  "majidalfuttaim.com", // Carrefour Marketplace (sellercom@carrefourmarketplace.majidalfuttaim.com)
];

export function isPlatformSender(address: string): boolean {
  const at = address.trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return false;
  const domain = address.trim().toLowerCase().slice(at + 1);
  return PLATFORM_DOMAINS.some((platform) => domain === platform || domain.endsWith(`.${platform}`));
}
