import { findAdminById, getVaultSecretSealed, openVaultSecret, recordVaultReveal, vaultConfigured } from "@nexus/db";
import { verifySecret } from "@nexus/employees";
import { getRedisConnection } from "../queue/queue.js";
import { logger } from "../lib/logger.js";

/**
 * Unlocking the Business HQ vault (spec 2026-10-14-business-hq-design.md §5.3–§5.4).
 *
 * - The signed-in admin's OWN password opens a 5-minute window, held in Redis
 *   (`hq:unlock:<adminId>`) — never in a cookie or the browser, so closing the
 *   tab or copying a cookie does not carry it anywhere.
 * - Five wrong passwords lock unlocking for 15 minutes
 *   (`hq:unlock-fail:<adminId>`), whatever is typed next.
 * - A reveal needs a live window, and is LOGGED BEFORE the password is
 *   returned: if the log cannot be written, the password is not given out.
 *
 * Dependencies are injectable so the tests run the real rules on a stand-in
 * Redis and clock.
 */
const UNLOCK_SECONDS = 300;
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 900;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

export interface VaultUnlockDeps {
  redis: RedisLike;
  findAdmin: (adminId: string) => Promise<{ passwordHash: string; isActive: boolean } | null>;
  verify: (plain: string, stored: string) => boolean;
  configured: () => boolean;
  getSealed: (organizationId: string, entryId: string) => Promise<string | null>;
  open: (sealed: string) => string;
  recordReveal: (row: { entryId: string; organizationId: string; adminId: string; ip: string | null; userAgent: string | null }) => Promise<void>;
}

function realDeps(): VaultUnlockDeps {
  return {
    redis: getRedisConnection() as unknown as RedisLike,
    findAdmin: async (id) => {
      const admin = await findAdminById(id);
      return admin ? { passwordHash: admin.passwordHash, isActive: admin.isActive } : null;
    },
    verify: (plain, stored) => verifySecret(plain, stored),
    configured: vaultConfigured,
    getSealed: getVaultSecretSealed,
    open: openVaultSecret,
    recordReveal: recordVaultReveal,
  };
}

const unlockKey = (adminId: string) => `hq:unlock:${adminId}`;
const failKey = (adminId: string) => `hq:unlock-fail:${adminId}`;

export async function unlockVault(
  adminId: string,
  password: string,
  deps: VaultUnlockDeps = realDeps()
): Promise<{ ok: true; expiresInSeconds: 300 } | { ok: false; reason: "wrong-password" | "locked-out"; retryInSeconds?: number }> {
  const failures = Number((await deps.redis.get(failKey(adminId))) ?? 0);
  if (failures >= MAX_FAILURES) {
    const ttl = await deps.redis.ttl(failKey(adminId));
    return { ok: false, reason: "locked-out", retryInSeconds: ttl > 0 ? ttl : LOCKOUT_SECONDS };
  }

  const admin = await deps.findAdmin(adminId);
  const right = !!admin && admin.isActive && !!password && deps.verify(password, admin.passwordHash);
  if (!right) {
    const count = await deps.redis.incr(failKey(adminId));
    // The window starts at the first failure, and restarts at the fifth so the
    // lock-out is a full 15 minutes from the attempt that triggered it.
    if (count === 1 || count >= MAX_FAILURES) await deps.redis.expire(failKey(adminId), LOCKOUT_SECONDS);
    logger.warn({ adminId, failures: count }, "Business HQ vault unlock refused — wrong password");
    return { ok: false, reason: "wrong-password" };
  }

  await deps.redis.del(failKey(adminId));
  await deps.redis.set(unlockKey(adminId), "1", "EX", UNLOCK_SECONDS);
  logger.info({ adminId }, "Business HQ vault unlocked for 5 minutes");
  return { ok: true, expiresInSeconds: UNLOCK_SECONDS };
}

/** Seconds left in this admin's unlock window; 0 means locked. */
export async function vaultUnlockedFor(adminId: string, deps: VaultUnlockDeps = realDeps()): Promise<number> {
  const ttl = await deps.redis.ttl(unlockKey(adminId));
  return ttl > 0 ? ttl : 0;
}

export async function lockVault(adminId: string, deps: VaultUnlockDeps = realDeps()): Promise<void> {
  await deps.redis.del(unlockKey(adminId));
}

export async function revealVaultSecret(
  input: { orgId: string; entryId: string; adminId: string; ip: string | null; userAgent: string | null },
  deps: VaultUnlockDeps = realDeps()
): Promise<{ ok: true; secret: string } | { ok: false; status: 423 | 404 | 503; error: string }> {
  if (!deps.configured()) return { ok: false, status: 503, error: "The vault key is not set on the server." };
  // 423 Locked, never 401: the web client reads every 401 as a lapsed session.
  if ((await vaultUnlockedFor(input.adminId, deps)) === 0) return { ok: false, status: 423, error: "Unlock again" };

  const sealed = await deps.getSealed(input.orgId, input.entryId);
  if (!sealed) return { ok: false, status: 404, error: "That login has no saved password, or no longer exists." };

  let secret: string;
  try {
    secret = deps.open(sealed);
  } catch {
    return { ok: false, status: 503, error: "That password could not be opened with the server's vault key." };
  }

  try {
    await deps.recordReveal({
      entryId: input.entryId,
      organizationId: input.orgId,
      adminId: input.adminId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  } catch (err) {
    logger.error({ err, entryId: input.entryId }, "Business HQ reveal refused — the reveal could not be logged");
    return { ok: false, status: 503, error: "The reveal could not be logged, so the password was not shown." };
  }
  return { ok: true, secret };
}
