import { randomUUID } from "node:crypto";
import { getRedisConnection } from "./queue.js";
import { logger } from "../lib/logger.js";

/**
 * One customer's messages are answered one at a time.
 *
 * ============================================================
 * WHAT HAPPENS WITHOUT THIS
 * ============================================================
 *
 * The inbound worker runs at `concurrency: 10` and nothing serialises work per
 * conversation. People do not message in one tidy paragraph — they send "Hello
 * dear", then "How are u?", then the actual question, seconds apart. Meta
 * delivers a webhook for each, and up to ten of them are processed in parallel.
 *
 * Every one of those jobs loads the conversation independently, decides
 * independently, and replies independently. None of them can see the others.
 *
 * MEASURED ON PRODUCTION, 6 August, one contact:
 *
 *   13:25:50  in   "Hello dear"
 *   13:25:56  out  "Hello! Welcome to Zipicka. How can I help you today?"
 *   13:25:59  in   "How are u?"
 *   13:26:03  out  "I'm doing great, thank you for asking! How can I help you today?"
 *   13:26:03  in   [a property-data sales pitch]
 *   13:26:05  in   "Do you want to purchase latest updates in very low price ?"
 *   13:26:06  out  "Thank you for reaching out! I am the assistant for Zipicka..."
 *   13:26:09  out  "Thank you for the offer, but we do not purchase external lead..."
 *
 * Four replies in nineteen seconds, and the last two are three seconds apart
 * answering two halves of the same pitch — neither aware the other existed.
 * Across the whole history, five inbound pairs arrived less than ten seconds
 * apart out of thirty-nine messages, so this is not an edge case here; it is
 * how a meaningful share of customers type.
 *
 * ============================================================
 * WHAT THE LOCK BUYS
 * ============================================================
 *
 * It does not merge the messages, and deliberately so — that would be a
 * debounce, which adds latency to every conversation to fix some of them. It
 * makes the replies SEQUENTIAL, and sequential is what makes them coherent:
 * the second job loads history AFTER the first reply is written, so the agent
 * can see it said hello already and answers the actual question instead of
 * greeting the same person twice.
 *
 * ============================================================
 * WAIT, DO NOT THROW
 * ============================================================
 *
 * Contention is the normal case here, not a failure. Throwing would consume one
 * of the job's five attempts and push the reply behind an exponential backoff —
 * two seconds, then four — so a customer sending three quick messages would
 * wait longer for each. So the job WAITS for the lock, briefly, and only throws
 * if the wait is exhausted, which is the case where something really is stuck.
 *
 * The TTL is the safety net rather than the mechanism: it is longer than any
 * reply should take, so a worker killed mid-reply releases the conversation
 * rather than wedging it until somebody notices.
 */

/** Longer than any reply should take, so a killed worker cannot wedge a conversation. */
const LOCK_TTL_MS = 90_000;

/** Roughly three model calls. Past this something is stuck, not busy. */
const MAX_WAIT_MS = 20_000;

const POLL_MS = 200;

/** Deletes the lock only if we still hold it — a TTL expiry must not make us drop someone else's. */
const RELEASE = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export class ConversationBusyError extends Error {
  constructor(key: string) {
    super(`Another message for ${key} is still being answered after ${MAX_WAIT_MS}ms`);
    this.name = "ConversationBusyError";
  }
}

const keyFor = (scope: string) => `nexus:conversation-lock:${scope}`;

/**
 * Runs `fn` with nobody else answering the same customer.
 *
 * Keyed on the NUMBER AND THE SENDER rather than the conversation id, because
 * the conversation does not exist yet when the first message of one arrives —
 * and two simultaneous first messages are exactly the case that would otherwise
 * race to create it.
 */
export async function withConversationLock<T>(
  phoneNumberId: string,
  contactWaId: string,
  fn: () => Promise<T>
): Promise<T> {
  const scope = `${phoneNumberId}:${contactWaId}`;
  const key = keyFor(scope);
  const token = randomUUID();
  const redis = getRedisConnection();
  const startedAt = Date.now();

  for (;;) {
    const acquired = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
    if (acquired === "OK") break;

    if (Date.now() - startedAt >= MAX_WAIT_MS) {
      // Thrown so BullMQ retries with backoff. Reaching here means a reply has
      // been in flight for twenty seconds, which is a problem worth a retry
      // rather than something to answer over the top of.
      logger.warn({ scope }, "Gave up waiting to answer — another message is still in flight");
      throw new ConversationBusyError(scope);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const waited = Date.now() - startedAt;
  if (waited > POLL_MS) {
    logger.info({ scope, waitedMs: waited }, "Waited for the previous message to this contact to be answered");
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE, 1, key, token);
    } catch (err) {
      // The TTL will clear it. Failing to release must not turn a delivered
      // reply into a failed job that gets retried and sent twice.
      logger.warn({ scope, err }, "Could not release the conversation lock — the TTL will");
    }
  }
}
