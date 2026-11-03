import { bulkTemplateLabel } from "@nexus/shared";

/**
 * How an approved message reads in a picker (3 Nov 2026): the words its author
 * gave it rather than WhatsApp's code name. "bulk_zp_weekend_viewings" is the
 * admin's "Weekend viewings"; a staff member's "staff_50667769_offer" is
 * "Offer"; any other name loses its underscores. The language stays alongside.
 */
export function templateOptionLabel(name: string, language: string): string {
  const words = bulkTemplateLabel(name).replace(/^staff \d+ /, "");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${language})`;
}
