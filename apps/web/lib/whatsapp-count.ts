/**
 * What WhatsApp itself counted for a campaign, in a line (13 Nov 2026).
 *
 * Nexus's own Delivered figure is built from the receipts Meta pushes and the
 * replies customers send, and Meta does not always push the receipts: the first
 * SFS campaign showed 4 delivered while Meta's dashboard counted 150. So the
 * page says both, and names whose count this one is. The server leaves a
 * campaign out when WhatsApp gave no answer, so there is no "unknown" to word.
 */
export interface WhatsAppCount {
  /** Template messages Meta counts as delivered from the campaign's number in the day after it went. */
  delivered: number;
  /** About what Meta charged for them; null when it would not say. */
  cost: number | null;
  /** The WhatsApp account's currency, as Meta names it ("AED"). */
  currency: string | null;
}

export function whatsAppCountLine(count: WhatsAppCount): string {
  const delivered = `WhatsApp counts ${count.delivered.toLocaleString("en-US")} delivered`;
  // Charged nothing: no talk of money.
  if (count.cost === 0) return delivered;
  // "About": Meta itself calls these approximate charges until the invoice.
  if (count.cost && count.currency) return `${delivered} · about ${count.currency} ${count.cost.toFixed(2)}`;
  // THE CHARGE META KEEPS TO ITSELF. It will not give charges to a partner app
  // for a customer's account ("COST is not shown for businesses who bill through
  // a partner" — live, 13 Nov 2026), which is every number connected from Nexus.
  // The owner asked what a campaign cost, twice; the honest answer is where it is.
  return `${delivered} · for the cost, see WhatsApp Manager`;
}
