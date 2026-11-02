import { withSavepoint } from "@nexus/db";
import { logger } from "./logger.js";
import { explainSendError, isPaymentRefusal } from "./send-errors.js";
import { notePaymentRefusal } from "./payment-refusal.js";

/**
 * A free-text message to each person in the 24-hour window, now -- the admin
 * quick send and a staff member's quick message, which were one loop written
 * twice.
 *
 * ============================================================
 * ONE RECORD FAILING LOST THEM ALL (3 Nov 2026)
 * ============================================================
 *
 * Each person is messaged first and recorded second, and the whole send is one
 * transaction. When one record failed, Postgres refused everything after it and
 * the commit rolled back every record of the send -- while the answer said
 * "sent", and listed everyone after the failure as "could not be sent" although
 * WhatsApp had delivered to them. Now each record is its own savepoint: one
 * failing loses that one, and the person is counted sent (they were) and named
 * as not saved, so nobody is told their message is in a conversation it is not.
 */
export interface QuickRecipient {
  id: string;
  displayName: string | null;
  waId: string;
  conversationId: string;
}

export interface QuickSendOutcome {
  sent: number;
  failed: Array<{ name: string; reason: string }>;
  /** Messaged, but the record of it could not be saved to their conversation. */
  notRecorded: string[];
}

/** {name} → the recipient's first name, or "there". Exported for its test. */
export function personalise(text: string, displayName: string | null): string {
  const first = displayName?.trim().split(/\s+/)[0] || "there";
  return text.replace(/\{name\}/gi, first);
}

export async function sendQuickMessages(input: {
  people: QuickRecipient[];
  text: string;
  phoneNumberId: string;
  send(person: QuickRecipient, message: string): Promise<{ waMessageId: string | null }>;
  record(person: QuickRecipient, message: string, waMessageId: string | null): Promise<void>;
}): Promise<QuickSendOutcome> {
  const outcome: QuickSendOutcome = { sent: 0, failed: [], notRecorded: [] };
  for (const person of input.people) {
    const name = person.displayName ?? `+${person.waId}`;
    const message = personalise(input.text, person.displayName);
    let waMessageId: string | null;
    try {
      ({ waMessageId } = await input.send(person, message));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (isPaymentRefusal(raw)) await notePaymentRefusal(input.phoneNumberId, raw).catch(() => undefined);
      outcome.failed.push({ name, reason: explainSendError(raw) });
      continue;
    }
    outcome.sent += 1;
    try {
      await withSavepoint(() => input.record(person, message, waMessageId));
    } catch (err) {
      logger.error(
        { conversationId: person.conversationId, err },
        "A quick message was sent but could not be saved to the conversation"
      );
      outcome.notRecorded.push(name);
    }
  }
  return outcome;
}
