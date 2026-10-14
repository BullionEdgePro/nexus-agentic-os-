// The vault opens only for its owner, and remembers who looked (Business HQ
// spec §5.3–§5.4). Run for real with a stand-in Redis: the admin's OWN password
// opens a 5-minute window held on the server; five wrong passwords lock
// unlocking for 15 minutes; a reveal outside the window is refused and NOT
// logged as a reveal; a reveal inside it is logged before the password leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlockVault, vaultUnlockedFor, lockVault, revealVaultSecret } from "../src/services/vault-unlock.ts";

/** Just enough of Redis: strings with expiry, on a clock the test controls. */
function fakeRedis() {
  let now = 0;
  const store = new Map();
  const live = (k) => {
    const e = store.get(k);
    if (e && e.exp !== null && e.exp <= now) store.delete(k);
    return store.get(k);
  };
  return {
    advance: (s) => (now += s * 1000),
    async get(k) { return live(k)?.v ?? null; },
    async set(k, v, ...args) {
      const ex = args[0] === "EX" ? Number(args[1]) : null;
      if (args.includes("NX") && live(k)) return null;
      store.set(k, { v: String(v), exp: ex === null ? null : now + ex * 1000 });
      return "OK";
    },
    async del(k) { return store.delete(k) ? 1 : 0; },
    async incr(k) { const e = live(k); const n = Number(e?.v ?? 0) + 1; store.set(k, { v: String(n), exp: e?.exp ?? null }); return n; },
    async expire(k, s) { const e = live(k); if (e) e.exp = now + s * 1000; return e ? 1 : 0; },
    async ttl(k) { const e = live(k); if (!e) return -2; if (e.exp === null) return -1; return Math.ceil((e.exp - now) / 1000); },
  };
}

function deps(over = {}) {
  const reveals = [];
  const redis = fakeRedis();
  return {
    redis,
    reveals,
    deps: {
      redis,
      findAdmin: async (id) => (id === "a1" ? { passwordHash: "HASH:right", isActive: true } : null),
      verify: (plain, hash) => hash === `HASH:${plain}`,
      configured: () => true,
      getSealed: async (orgId, entryId) => (orgId === "org-sfs" && entryId === "e1" ? "SEALED:hunter2" : null),
      open: (sealed) => sealed.replace("SEALED:", ""),
      recordReveal: async (row) => reveals.push(row),
      ...over,
    },
  };
}

const REVEAL = { orgId: "org-sfs", entryId: "e1", adminId: "a1", ip: "94.200.1.2", userAgent: "Edge" };

test("the right password opens a 5-minute window, and Lock now closes it", async () => {
  const d = deps();
  assert.deepEqual(await unlockVault("a1", "right", d.deps), { ok: true, expiresInSeconds: 300 });
  assert.equal(await vaultUnlockedFor("a1", d.deps), 300);
  d.redis.advance(299);
  assert.equal(await vaultUnlockedFor("a1", d.deps), 1);
  d.redis.advance(2);
  assert.equal(await vaultUnlockedFor("a1", d.deps), 0, "it locks itself");
  await unlockVault("a1", "right", d.deps);
  await lockVault("a1", d.deps);
  assert.equal(await vaultUnlockedFor("a1", d.deps), 0);
});

test("five wrong passwords lock unlocking for 15 minutes, even for the right one", async () => {
  const d = deps();
  for (let i = 0; i < 5; i++) assert.equal((await unlockVault("a1", "wrong", d.deps)).reason, "wrong-password");
  const locked = await unlockVault("a1", "right", d.deps);
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "locked-out");
  assert.ok(locked.retryInSeconds > 0 && locked.retryInSeconds <= 900);
  d.redis.advance(901);
  assert.equal((await unlockVault("a1", "right", d.deps)).ok, true, "it opens again after 15 minutes");
});

test("an unknown admin is refused like a wrong password", async () => {
  const d = deps();
  assert.equal((await unlockVault("nobody", "right", d.deps)).reason, "wrong-password");
});

test("a reveal outside the window is refused, and is not logged as a reveal", async () => {
  const d = deps();
  const r = await revealVaultSecret(REVEAL, d.deps);
  assert.deepEqual(r, { ok: false, status: 423, error: "Unlock again" });
  assert.equal(d.reveals.length, 0);
});

test("the window closing between opening the vault and pressing Reveal refuses it", async () => {
  const d = deps();
  await unlockVault("a1", "right", d.deps);
  d.redis.advance(301);
  assert.equal((await revealVaultSecret(REVEAL, d.deps)).status, 423);
  assert.equal(d.reveals.length, 0);
});

test("a reveal inside the window returns the password and logs who, where and how", async () => {
  const d = deps();
  await unlockVault("a1", "right", d.deps);
  assert.deepEqual(await revealVaultSecret(REVEAL, d.deps), { ok: true, secret: "hunter2" });
  assert.deepEqual(d.reveals, [{ entryId: "e1", organizationId: "org-sfs", adminId: "a1", ip: "94.200.1.2", userAgent: "Edge" }]);
});

test("no log, no password: a reveal whose log cannot be written is refused", async () => {
  const d = deps({ recordReveal: async () => { throw new Error("db down"); } });
  await unlockVault("a1", "right", d.deps);
  const r = await revealVaultSecret(REVEAL, d.deps);
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test("without the vault key, or for another business's entry, nothing comes back", async () => {
  const off = deps({ configured: () => false });
  await unlockVault("a1", "right", off.deps);
  assert.deepEqual(await revealVaultSecret(REVEAL, off.deps), { ok: false, status: 503, error: "The vault key is not set on the server." });
  const d = deps();
  await unlockVault("a1", "right", d.deps);
  assert.equal((await revealVaultSecret({ ...REVEAL, orgId: "org-zipicka" }, d.deps)).status, 404);
  assert.equal(d.reveals.length, 0);
});
