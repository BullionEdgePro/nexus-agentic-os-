// A WhatsApp number nobody holds is shown to admins (5 Nov 2026).
//
// +971 58 848 3731 (SFS International Real Estate LLC) was connected to our
// Meta app -- CONNECTED, on the Business app -- and no person or business in
// Nexus held it: its connect had finished at Meta without Nexus hearing. 34
// customer messages and 24 receipts in a day were each logged as "unmapped"
// and dropped, and nobody could see it without reading the server's logs.
// Now each such delivery is counted per number, and admins see the list with
// the number's name, until somebody holds it.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Redis, in memory: the few commands this uses.
const sets = new Map();
const hashes = new Map();
let redisDown = false;
const fake = {
  async sadd(key, member) { if (redisDown) throw new Error("redis down"); (sets.get(key) ?? sets.set(key, new Set()).get(key)).add(member); },
  async smembers(key) { if (redisDown) throw new Error("redis down"); return [...(sets.get(key) ?? [])]; },
  async srem(key, member) { sets.get(key)?.delete(member); },
  async hsetnx(key, field, value) { const h = hashes.get(key) ?? hashes.set(key, {}).get(key); if (!(field in h)) h[field] = String(value); },
  async hset(key, field, value) { (hashes.get(key) ?? hashes.set(key, {}).get(key))[field] = String(value); },
  async hincrby(key, field, by) { const h = hashes.get(key) ?? hashes.set(key, {}).get(key); h[field] = String(Number(h[field] ?? 0) + by); },
  async hgetall(key) { return { ...(hashes.get(key) ?? {}) }; },
  async expire() {},
  async del(key) { hashes.delete(key); },
};
mock.module(new URL("../src/queue/queue.ts", import.meta.url).href, {
  namedExports: { getRedisConnection: () => fake },
});

const { noteUnheldNumber, listUnheldNumbers, unheldNumbersNow } = await import("../src/lib/unheld-numbers.ts");

const SFS = "1273619879166296";

test("each delivery to a number nobody holds is counted, first and last seen kept", async () => {
  await noteUnheldNumber(SFS, "message", new Date("2026-11-05T04:03:46Z"));
  await noteUnheldNumber(SFS, "receipt", new Date("2026-11-05T05:30:47Z"));
  await noteUnheldNumber(SFS, "message", new Date("2026-11-05T09:12:00Z"));
  assert.deepEqual(await listUnheldNumbers(), [
    {
      phoneNumberId: SFS,
      firstSeen: "2026-11-05T04:03:46.000Z",
      lastSeen: "2026-11-05T09:12:00.000Z",
      messages: 2,
      receipts: 1,
    },
  ]);
});

test("admins see it named; once somebody holds it, it leaves the list for good", async () => {
  const described = await unheldNumbersNow({
    isHeld: async () => false,
    describe: async () => ({ displayNumber: "+971 58 848 3731", verifiedName: "SFS INTERNATIONAL REAL ESTATE LLC" }),
  });
  assert.equal(described.length, 1);
  assert.equal(described[0].displayNumber, "+971 58 848 3731");
  assert.equal(described[0].verifiedName, "SFS INTERNATIONAL REAL ESTATE LLC");
  assert.equal(described[0].messages, 2);

  const afterConnect = await unheldNumbersNow({
    isHeld: async (id) => id === SFS,
    describe: async () => assert.fail("a held number is not looked up"),
  });
  assert.deepEqual(afterConnect, []);
  assert.deepEqual(await listUnheldNumbers(), [], "a held number must be forgotten, not only hidden");
});

test("a name Meta will not give still shows the number's id", async () => {
  await noteUnheldNumber("555", "message");
  const [only] = await unheldNumbersNow({ isHeld: async () => false, describe: async () => { throw new Error("graph down"); } });
  assert.equal(only.phoneNumberId, "555");
  assert.equal(only.displayNumber, null);
});

test("Redis being down never costs the delivery beside it", async () => {
  redisDown = true;
  await noteUnheldNumber("556", "message");
  assert.deepEqual(await listUnheldNumbers(), []);
  redisDown = false;
});

test("both places that drop a delivery for an unknown number count it", () => {
  const processor = readFileSync(new URL("../src/queue/processor.ts", import.meta.url), "utf8");
  const receipt = processor.slice(processor.indexOf('"Delivery status for an unmapped phone_number_id"') - 300);
  assert.match(receipt.slice(0, 500), /noteUnheldNumber\(phoneNumberId, "receipt"\)/);
  const inbound = processor.slice(processor.indexOf('"No organization mapped to inbound phone_number_id"') - 300);
  assert.match(inbound.slice(0, 500), /noteUnheldNumber\(phoneNumberId, "message"\)/);
});

test("only an admin may list them", () => {
  const route = readFileSync(new URL("../src/routes/connections.ts", import.meta.url), "utf8");
  const handler = route.slice(route.indexOf('connectionsRoute.get("/whatsapp/unheld"'));
  assert.ok(handler.length > 0, "the route exists");
  assert.match(handler.slice(0, 400), /scopeOf\(c\)\.role !== "operator"/);
  assert.match(handler.slice(0, 400), /403/);
});
