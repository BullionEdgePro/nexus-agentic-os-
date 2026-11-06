import { getRedisConnection } from "../queue/queue.js";
import { logger } from "./logger.js";

/**
 * WhatsApp numbers that reach Nexus while nobody holds them (5 Nov 2026).
 *
 * +971 58 848 3731 (SFS International Real Estate LLC) was connected to our
 * Meta app and held by no person or business here: its connect finished at Meta
 * without Nexus hearing. Every customer message and receipt for it was logged as
 * "unmapped" and dropped — 34 messages in a day — and nobody saw it without the
 * server's logs. Each such delivery is now counted here, and admins see the list
 * on Connections until somebody holds the number.
 *
 * Kept in Redis beside the other small per-person notes (staff-changes.ts), for
 * 14 days after the last delivery: a count, not the messages themselves. When
 * the number is connected again, the chats on that phone are copied in by the
 * app sync (whatsapp-history.ts), which is how what was missed comes back.
 */

const NUMBERS = "wa-unheld";
const KEY = (phoneNumberId: string) => `wa-unheld:${phoneNumberId}`;
const KEEP_SECONDS = 14 * 24 * 60 * 60;

/**
 * The shared connection, only when it is connected (review, 5 Nov 2026). It
 * retries a command forever while Redis is away (queue.ts), so asking it then
 * would hang an admin's request — and queue counts nobody needs.
 */
async function connectedRedis() {
  const redis = getRedisConnection();
  if (redis.status !== "ready") {
    // Still connecting just after a start: a moment's grace, never more.
    await new Promise<void>((resolve) => {
      const onReady = () => {
        clearTimeout(giveUp);
        resolve();
      };
      // The listener goes with the wait, or an outage would pile them up.
      const giveUp = setTimeout(() => {
        redis.off("ready", onReady);
        resolve();
      }, 1000);
      redis.once("ready", onReady);
    });
  }
  return redis.status === "ready" ? redis : null;
}

export interface UnheldNumber {
  phoneNumberId: string;
  firstSeen: string;
  lastSeen: string;
  messages: number;
  receipts: number;
}

export interface DescribedUnheldNumber extends UnheldNumber {
  /** As Meta shows it, when Meta answers. */
  displayNumber: string | null;
  verifiedName: string | null;
}

/** Count one delivery for a number nobody holds. Never throws. */
export async function noteUnheldNumber(
  phoneNumberId: string,
  what: "message" | "receipt",
  at: Date = new Date()
): Promise<void> {
  try {
    const redis = await connectedRedis();
    if (!redis) return;
    const key = KEY(phoneNumberId);
    await redis.sadd(NUMBERS, phoneNumberId);
    await redis.hsetnx(key, "firstSeen", at.toISOString());
    await redis.hset(key, "lastSeen", at.toISOString());
    await redis.hincrby(key, what === "message" ? "messages" : "receipts", 1);
    await redis.expire(key, KEEP_SECONDS);
  } catch (err) {
    logger.warn({ err, phoneNumberId }, "Could not count a delivery for a number nobody holds");
  }
}

/** Every number counted in the last 14 days, most recent first. */
export async function listUnheldNumbers(): Promise<UnheldNumber[]> {
  try {
    const redis = await connectedRedis();
    if (!redis) return [];
    const out: UnheldNumber[] = [];
    for (const phoneNumberId of await redis.smembers(NUMBERS)) {
      const fields = await redis.hgetall(KEY(phoneNumberId));
      if (!fields.lastSeen) {
        // Its count expired: nothing has arrived for it in 14 days.
        await redis.srem(NUMBERS, phoneNumberId);
        continue;
      }
      out.push({
        phoneNumberId,
        firstSeen: fields.firstSeen ?? fields.lastSeen,
        lastSeen: fields.lastSeen,
        messages: Number(fields.messages ?? 0),
        receipts: Number(fields.receipts ?? 0),
      });
    }
    return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  } catch {
    return [];
  }
}

async function forgetUnheldNumber(phoneNumberId: string): Promise<void> {
  const redis = await connectedRedis();
  if (!redis) return;
  await redis.srem(NUMBERS, phoneNumberId);
  await redis.del(KEY(phoneNumberId));
}

/**
 * The list as admins should see it: numbers somebody now holds are forgotten,
 * the rest named by Meta when it answers. The lookups are passed in so this
 * reads the same in a test as on the server.
 */
export async function unheldNumbersNow(lookups: {
  isHeld: (phoneNumberId: string) => Promise<boolean>;
  describe: (phoneNumberId: string) => Promise<{ displayNumber: string | null; verifiedName: string | null }>;
}): Promise<DescribedUnheldNumber[]> {
  const out: DescribedUnheldNumber[] = [];
  for (const number of await listUnheldNumbers()) {
    if (await lookups.isHeld(number.phoneNumberId)) {
      await forgetUnheldNumber(number.phoneNumberId).catch(() => undefined);
      continue;
    }
    const named = await lookups.describe(number.phoneNumberId).catch(() => ({ displayNumber: null, verifiedName: null }));
    out.push({ ...number, ...named });
  }
  return out;
}
