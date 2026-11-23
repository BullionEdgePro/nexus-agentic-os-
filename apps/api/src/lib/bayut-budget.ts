import type { Redis } from "ioredis";
import { getRedisConnection } from "../queue/queue.js";
import { logger } from "./logger.js";

/**
 * Bayut's call budget (23 Nov 2026): at most 40 Bayut calls a minute for each
 * business — the sync's and the location search's together — counted in
 * Redis, so Nexus stays under Bayut's own limit (60 a minute per token) with
 * room to spare. A call the budget refuses is not counted; the caller stops and
 * the next run goes on. A 429 from Bayut pauses that business until Bayut's
 * own retry_after has passed.
 *
 * IT FAILS OPEN. With Redis unreachable the call goes ahead: Bayut still
 * answers an overrun with a 429, which stops the run, while holding calls back
 * would hold back a take-down — and a listing left advertised after its permit
 * expired is the worse failure.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §10
 */

export const BAYUT_CALLS_PER_MINUTE = 40;

/** The Redis commands the budget and the sync's amenity cache use, so a test can hand in a stand-in. */
export type BayutRedis = Pick<Redis, "get" | "set" | "incrby" | "decrby" | "expire">;

type Deps = { redis?: BayutRedis; now?: () => Date };

export const bayutRedis = (deps: { redis?: BayutRedis }): BayutRedis => deps.redis ?? getRedisConnection();

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** True when `n` more calls fit in this minute's budget for the business (and they are counted). */
export async function takeBayutCalls(organizationId: string, n: number, deps: Deps = {}): Promise<boolean> {
  const minute = Math.floor((deps.now?.() ?? new Date()).getTime() / 60_000);
  const key = `bayut-calls:${organizationId}:${minute}`;
  try {
    const redis = bayutRedis(deps);
    const used = await redis.incrby(key, n);
    await redis.expire(key, 120);
    if (used <= BAYUT_CALLS_PER_MINUTE) return true;
    await redis.decrby(key, n);
    return false;
  } catch (err) {
    logger.warn({ organizationId, err: why(err) }, "Bayut call budget unavailable — the call goes ahead");
    return true;
  }
}

/** After a 429: no Bayut call for this business until `seconds` have passed. */
export async function pauseBayut(organizationId: string, seconds: number, deps: Deps = {}): Promise<void> {
  try {
    await bayutRedis(deps).set(`bayut-paused:${organizationId}`, "1", "EX", Math.max(1, Math.ceil(seconds)));
  } catch (err) {
    logger.warn({ organizationId, err: why(err) }, "Could not pause the Bayut sync — Bayut's next 429 stops it again");
  }
}

export async function bayutPaused(organizationId: string, deps: Deps = {}): Promise<boolean> {
  try {
    return (await bayutRedis(deps).get(`bayut-paused:${organizationId}`)) !== null;
  } catch {
    return false;
  }
}

/** The budget as the sync uses it; a test may hand in its own. */
export type Budget = {
  take(organizationId: string, n: number): Promise<boolean>;
  pause(organizationId: string, seconds: number): Promise<void>;
  paused(organizationId: string): Promise<boolean>;
};

export function bayutBudget(deps: Deps = {}): Budget {
  return {
    take: (organizationId, n) => takeBayutCalls(organizationId, n, deps),
    pause: (organizationId, seconds) => pauseBayut(organizationId, seconds, deps),
    paused: (organizationId) => bayutPaused(organizationId, deps),
  };
}
