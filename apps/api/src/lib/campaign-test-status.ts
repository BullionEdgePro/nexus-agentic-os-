import { getRedisConnection } from "../queue/queue.js";

/**
 * What became of a campaign test send, after Meta accepted it.
 *
 * ============================================================
 * WHY "SENT" WAS NOT AN ANSWER
 * ============================================================
 *
 * A test leaves no broadcast row and no message row on purpose, so when Meta
 * later reported it — delivered, or FAILED with a reason — the status webhook
 * matched nothing and was dropped without a log line. The screen said "Sent.
 * Check that WhatsApp" for a message WhatsApp had already refused to deliver
 * (Ralph, 28 Oct 2026), and nothing anywhere recorded why.
 *
 * So the API notes each test's message id here when Meta accepts it, the worker
 * writes the receipt onto that note when one arrives, and the screen asks until
 * there is an outcome. In Redis because the API and the worker are separate
 * processes and this lives a day: it is a receipt, not a record.
 */

export type TestSendState = "accepted" | "sent" | "delivered" | "read" | "failed";

export interface TestSendStatus {
  employeeId: string;
  state: TestSendState;
  reason: string | null;
  at: string;
}

const KEY = (messageId: string) => `campaign-test:${messageId}`;
const TTL_SECONDS = 86_400;

// Receipts can arrive out of order — a late "sent" must not undo "delivered".
// A failure is final whenever it arrives.
const RANK: Record<TestSendState, number> = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/** Whether `next` should replace `current`. Exported for its test. */
export function testStateAdvances(current: TestSendState, next: TestSendState): boolean {
  if (current === "failed") return false;
  return next === "failed" || RANK[next] > RANK[current];
}

export async function noteTestSend(messageId: string, employeeId: string): Promise<void> {
  const status: TestSendStatus = { employeeId, state: "accepted", reason: null, at: new Date().toISOString() };
  await getRedisConnection().set(KEY(messageId), JSON.stringify(status), "EX", TTL_SECONDS);
}

export async function readTestSend(messageId: string): Promise<TestSendStatus | null> {
  const raw = await getRedisConnection().get(KEY(messageId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TestSendStatus;
  } catch {
    return null;
  }
}

/**
 * Apply a delivery receipt to a test send, if the message id is one. Returns
 * whether it was — false for every receipt that belongs to anything else.
 */
export async function recordTestSendReceipt(
  messageId: string,
  state: Exclude<TestSendState, "accepted">,
  reason: string | null
): Promise<boolean> {
  const current = await readTestSend(messageId);
  if (!current) return false;
  if (!testStateAdvances(current.state, state)) return true;
  const next: TestSendStatus = { ...current, state, reason: state === "failed" ? reason : null, at: new Date().toISOString() };
  await getRedisConnection().set(KEY(messageId), JSON.stringify(next), "EX", TTL_SECONDS);
  return true;
}
