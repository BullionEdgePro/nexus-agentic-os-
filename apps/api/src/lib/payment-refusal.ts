import { getRedisConnection } from "../queue/queue.js";

/**
 * The last time WhatsApp refused a number's messages over payment (131042),
 * until something from that number is delivered again.
 *
 * ============================================================
 * WHY THE HEALTH CHECK WAS NOT ENOUGH
 * ============================================================
 *
 * On 29 Oct 2026 `health_status` said the WhatsApp account could send — a card
 * was on it, currency AED — and the readiness screen went green. The very next
 * test came back 131042, "errors related to your payment method": the card
 * was there but Meta could not charge it. The health answer only knows a card
 * EXISTS; the refusal is the only evidence that it works. So a refusal is
 * remembered per number and turns the account check red, and the first
 * delivered or read receipt from that number clears it. A test send is never
 * gated on readiness, so the way out — fix the card, send a test — stays open.
 */

export interface PaymentRefusal {
  at: string;
  reason: string;
}

const KEY = (phoneNumberId: string) => `wa-payment-refused:${phoneNumberId}`;
// A week: long enough to stop a campaign the next morning, short enough that a
// number nobody tests again is not refused forever on a stale answer.
const TTL_SECONDS = 7 * 86_400;

export async function notePaymentRefusal(phoneNumberId: string, reason: string): Promise<void> {
  const value: PaymentRefusal = { at: new Date().toISOString(), reason: reason.slice(0, 300) };
  await getRedisConnection().set(KEY(phoneNumberId), JSON.stringify(value), "EX", TTL_SECONDS);
}

export async function clearPaymentRefusal(phoneNumberId: string): Promise<void> {
  await getRedisConnection().del(KEY(phoneNumberId));
}

/** null when nothing is remembered, or the store cannot be read. */
export async function readPaymentRefusal(phoneNumberId: string): Promise<PaymentRefusal | null> {
  try {
    const raw = await getRedisConnection().get(KEY(phoneNumberId));
    return raw ? (JSON.parse(raw) as PaymentRefusal) : null;
  } catch {
    return null;
  }
}
