import { readNumberStanding, readSendingHealth } from "./whatsapp-client.js";
import { readPaymentRefusal } from "./payment-refusal.js";

/**
 * Why WhatsApp would refuse a campaign from this number right now, or null.
 * Send checks it; so does a new message that will send itself once approved,
 * before anything is created and again when it is released (3 Nov 2026).
 */
export async function sendingRefusal(phoneNumberId: string): Promise<string | null> {
  const [health, refused, standing] = await Promise.all([
    readSendingHealth(phoneNumberId),
    readPaymentRefusal(phoneNumberId),
    readNumberStanding(phoneNumberId),
  ]);
  if (health?.problem) return `WhatsApp is blocking this number: ${health.problem.description}`;
  if (refused) return "WhatsApp refused this number's last message over payment. Fix the card and send a test first.";
  if (standing?.quality === "RED") return "WhatsApp rates this number's quality as low (red). Nothing was sent.";
  return null;
}
