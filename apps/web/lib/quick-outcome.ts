/**
 * What the screen says after a quick send (3 Nov 2026).
 *
 * Each message is sent first and recorded second. A person whose record could
 * not be saved still got the message: they are not "could not be sent", and
 * "each one is in that client's conversation" is not true of them, so they are
 * named with what did and did not happen. `notRecorded` is optional so an
 * answer from an API without it still reads.
 */
export const NOT_SAVED = "Sent, but could not be saved to their conversation, so it will not show in the inbox.";

export interface QuickOutcome {
  sent: number;
  failed: Array<{ name: string; reason: string }>;
  notRecorded?: string[];
}

export function describeQuickOutcome(outcome: QuickOutcome): {
  ok: boolean;
  text: string;
  failed: Array<{ name: string; reason: string }>;
} {
  const notRecorded = outcome.notRecorded ?? [];
  const people = `${outcome.sent} ${outcome.sent === 1 ? "person" : "people"}`;
  const couldNotSend = outcome.failed.length ? `; ${outcome.failed.length} could not be sent` : "";
  const where = notRecorded.length
    ? ` ${notRecorded.length} of them could not be saved to their conversation.`
    : " Each one is in that client's conversation.";
  return {
    ok: outcome.failed.length === 0 && notRecorded.length === 0,
    text: `Sent to ${people}${couldNotSend}.${where}`,
    failed: [...outcome.failed, ...notRecorded.map((name) => ({ name, reason: NOT_SAVED }))],
  };
}
