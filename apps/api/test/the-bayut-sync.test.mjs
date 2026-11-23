// The Bayut sync (23 Nov 2026): for each business with a checked token, in this
// order — removals first (compliance first, so a spent call budget can never
// hold back a take-down), then creates, updates and publishes, then Bayut's own
// answers (the state list, the permit check of pending units, the rejected
// list). A publish is asked once and waited for, never twice in 24 hours; a
// refusal waits for the listing to change; a portal Bayut took down is switched
// off with the date and never republished on its own; at most 40 Bayut calls a
// minute for each business; a 429 pauses that business, a refused token stops
// it, and neither touches another business. Bayut is a scripted stand-in.
//
// Database cases run against the throwaway Postgres (see the-bayut-tables).
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §1, §9, §10, §11
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const migration = (name) => readFileSync(join(root, "packages", "db", "migrations", name), "utf8");
const source = (...p) => readFileSync(join(root, "apps", "api", "src", ...p), "utf8");

/** Redis, in memory: the commands the budget and the amenity cache use. */
function fakeRedis() {
  const kept = new Map();
  return {
    kept,
    async get(k) {
      return kept.get(k)?.value ?? null;
    },
    async set(k, v, mode, ex) {
      kept.set(k, { value: String(v), ex: mode === "EX" ? ex : null });
      return "OK";
    },
    async incrby(k, n) {
      const v = Number(kept.get(k)?.value ?? 0) + n;
      kept.set(k, { value: String(v), ex: kept.get(k)?.ex ?? null });
      return v;
    },
    async decrby(k, n) {
      return this.incrby(k, -n);
    },
    async expire(k, s) {
      const e = kept.get(k);
      if (!e) return 0;
      e.ex = s;
      return 1;
    },
  };
}

test("the fingerprint ignores the order of the body's keys", async () => {
  const { bayutFingerprint } = await import("../src/services/bayut-sync.ts");
  const a = { reference: "u1", title: { en: "Sea view" }, images: [{ path: "p1", is_main: true }], price: 95000 };
  const b = { price: 95000, images: [{ is_main: true, path: "p1" }], title: { en: "Sea view" }, reference: "u1" };
  assert.equal(bayutFingerprint(a), bayutFingerprint(b));
  assert.match(bayutFingerprint(a), /^[0-9a-f]{64}$/);
  assert.notEqual(bayutFingerprint(a), bayutFingerprint({ ...a, price: 96000 }));
});

test("queueBayutUnit adds the unit's job, 30 seconds later, under the unit's id; a token save queues a cycle", async () => {
  const { queueBayutUnit, queueBayutCycle, BAYUT_SYNC_QUEUE } = await import("../src/queue/bayut-sync-queue.ts");
  assert.equal(BAYUT_SYNC_QUEUE, "bayut-sync");
  const added = [];
  const queue = { add: async (...args) => added.push(args) };
  await queueBayutUnit("org-1", "u1", { queue });
  assert.deepEqual(added, [[
    "unit",
    { organizationId: "org-1", unitId: "u1" },
    { jobId: "bayut-unit-u1", delay: 30000, removeOnComplete: true, removeOnFail: true },
  ]]);
  await queueBayutCycle({ queue });
  assert.deepEqual(added[1], ["cycle", {}, { removeOnComplete: true, removeOnFail: true }]);
});

test("the call budget: 40 a minute for each business; a refused take is not counted; a new minute starts afresh", async () => {
  const { takeBayutCalls, BAYUT_CALLS_PER_MINUTE } = await import("../src/lib/bayut-budget.ts");
  assert.equal(BAYUT_CALLS_PER_MINUTE, 40);
  const redis = fakeRedis();
  const deps = { redis, now: () => new Date("2026-11-24T08:00:10Z") };
  assert.equal(await takeBayutCalls("org-1", 38, deps), true);
  assert.equal(await takeBayutCalls("org-1", 3, deps), false, "three more would be 41");
  assert.equal(await takeBayutCalls("org-1", 2, deps), true, "the refused three were not counted");
  assert.equal(await takeBayutCalls("org-1", 1, deps), false);
  assert.equal(await takeBayutCalls("org-2", 1, deps), true, "each business has its own");
  assert.equal(await takeBayutCalls("org-1", 1, { redis, now: () => new Date("2026-11-24T08:01:00Z") }), true, "a new minute");
  const counter = [...redis.kept.keys()].find((k) => k.startsWith("bayut-calls:org-1:"));
  assert.ok(redis.kept.get(counter).ex > 0, "the count expires");
});

test("a 429 pauses one business until Bayut's retry_after; an unreachable Redis lets the call go", async () => {
  const { takeBayutCalls, pauseBayut, bayutPaused } = await import("../src/lib/bayut-budget.ts");
  const redis = fakeRedis();
  await pauseBayut("org-1", 120, { redis });
  assert.equal(await bayutPaused("org-1", { redis }), true);
  assert.equal(await bayutPaused("org-2", { redis }), false);
  assert.equal(redis.kept.get("bayut-paused:org-1").ex, 120);
  const down = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const broken = { get: down, set: down, incrby: down, decrby: down, expire: down };
  assert.equal(await takeBayutCalls("org-1", 1, { redis: broken }), true, "Bayut's own 429 still answers an overrun");
  assert.equal(await bayutPaused("org-1", { redis: broken }), false);
});

test("the worker runs the Bayut sync one job at a time, schedules it, closes it, and its queue is watched", () => {
  const worker = source("worker.ts");
  assert.match(worker, /new Worker\(BAYUT_SYNC_QUEUE, processBayutSyncJob, \{\s*connection: getRedisConnection\(\),\s*concurrency: 1,/);
  assert.match(worker, /scheduleBayutSync\(\)/);
  assert.match(worker, /bayutSyncWorker\.close\(\)/);
  assert.match(source("queue", "queue-health.ts"), /^\s+BAYUT_SYNC_QUEUE,$/m);
  assert.match(source("queue", "bayut-sync-processor.ts"), /withJobHeartbeat\("bayut-sync",/);
  assert.match(source("queue", "bayut-sync-queue.ts"), /repeat: \{ every: EVERY_TEN_MINUTES_MS \}/);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11140000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OTHER = id(1); // sorts first: its 429 and its refused token must not stop SFS
const SFS = id(2);
const AISHA = id(11);
const OMAR = id(12); // OTHER's agent
const R = id(21); // ready, wanted on Bayut and dubizzle
const N = id(22); // ready, wanted on Bayut, but no Bayut location
const M = id(23); // ready; ticked from test 9
const P = id(24); // ready; ticked from test 11
const O = id(25); // OTHER's, ready; ticked from test 13
const Q = id(26); // made ready and ticked in test 9b
const SFS_TOKEN = "sfs-sandbox-token-0000-aaaa";
const OTHER_TOKEN = "other-sandbox-token-0000-bbbb";
const WHO = { [SFS_TOKEN]: "sfs", [OTHER_TOKEN]: "other" };
const PERMIT_CHECK = "Compliance status is Pending our team's review";

let clock = new Date("2026-11-24T08:00:00Z"); // 12:00 in Dubai
const hoursLater = (h) => (clock = new Date(clock.getTime() + h * 3600_000));
const dayMonth = (d) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(d);

/** Bayut, scripted: every call recorded by business; listings kept with each portal's state. */
const calls = [];
const everyCall = [];
const script = {};
const refusedToken = new Set();
const rateLimited = new Set();
const store = new Map(); // Bayut id → { who, portals: { bayut, dubizzle } }
let rejectedList = [];
let nextId = 21;
const sent = new Map(); // Bayut id or unit id → last body sent

async function answer(fn, token, what, args, fallback) {
  const who = WHO[token] ?? "nobody";
  calls.push({ who, what });
  everyCall.push(what);
  if (refusedToken.has(who)) return { ok: false, kind: "token-refused", message: "Unauthenticated." };
  if (rateLimited.has(who)) return { ok: false, kind: "rate-limited", message: "Rate limit exceeded", retryAfter: 120 };
  const s = script[fn];
  if (s) {
    const a = await s(...args);
    if (a !== undefined) return a;
  }
  return fallback();
}
const portalsOf = (bayutId) => Object.entries(store.get(bayutId)?.portals ?? {}).map(([name, state]) => ({ name, state }));
const unused = async () => {
  throw new Error("not a sync call");
};
const client = {
  agencies: unused,
  users: unused,
  locations: unused,
  amenities: (token) =>
    answer("amenities", token, "amenities", [], () => ({
      ok: true,
      data: [{ id: "a-1", title: { en: "Balcony or Terrace" } }, { id: "a-2", title: { en: "Shared Gym" } }],
    })),
  create: (token, body) =>
    answer("create", token, `create ${body.reference}`, [body], () => {
      const bayutId = `BY-${nextId++}`;
      store.set(bayutId, { who: WHO[token], portals: { bayut: "draft", dubizzle: "draft" } });
      sent.set(body.reference, body);
      return { ok: true, data: { id: bayutId } };
    }),
  update: (token, bayutId, body) =>
    answer("update", token, `update ${bayutId}`, [bayutId, body], () => {
      sent.set(bayutId, body);
      return { ok: true, data: null };
    }),
  // Bayut publishes asynchronously: the state list shows it later.
  publish: (token, bayutId, portals) =>
    answer("publish", token, `publish ${bayutId} ${portals.join(",")}`, [bayutId, portals], () => ({ ok: true, data: null })),
  remove: (token, bayutId, portals) =>
    answer("remove", token, `remove ${bayutId} ${portals.join(",")}`, [bayutId, portals], () => {
      for (const p of portals) if (store.has(bayutId)) store.get(bayutId).portals[p] = "inactive";
      return { ok: true, data: null };
    }),
  show: (token, bayutId) =>
    answer("show", token, `show ${bayutId}`, [bayutId], () => ({
      ok: true,
      data: { portals: portalsOf(bayutId), permit: { status: "pending", comment: PERMIT_CHECK } },
    })),
  list: (token, agencyId, page) =>
    answer("list", token, `list ${agencyId} ${page}`, [agencyId, page], () => ({
      ok: true,
      data: {
        items: [...store].filter(([, v]) => v.who === WHO[token]).map(([bayutId]) => ({ id: bayutId, portals: portalsOf(bayutId) })),
        next: false,
      },
    })),
  rejected: (token) => answer("rejected", token, "rejected", [], () => ({ ok: true, data: rejectedList })),
};
const bayutSays = (bayutId, portals) => Object.assign(store.get(bayutId).portals, portals);
const made = (who = "sfs") => calls.filter((c) => c.who === who).map((c) => c.what);
const writes = (who = "sfs") => made(who).filter((w) => /^(create|update|publish|remove) /.test(w));

let redis = fakeRedis();
const run = (extra = {}) => sync.runBayutCycle({ client, redis, now: () => clock, ...extra });
const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(script)) delete script[k];
  refusedToken.clear();
  rateLimited.clear();
  // A fresh minute's budget for each test; the amenity ids and any pause are kept.
  for (const k of [...redis.kept.keys()]) if (k.startsWith("bayut-calls:")) redis.kept.delete(k);
};

let owner;
let dbTurn;
let lib;
let sync;
/** A unit ready for the portals, with photos (set in `before`). */
let ready;

const row = async (unit, portal) =>
  (await owner.query(`select * from unit_portals where unit_id = $1 and portal = $2`, [unit, portal])).rows[0];
const refOf = async (unit) => (await row(unit, "bayut"))?.remote_ref;
const retitle = (unit, title) => owner.query(`update property_units set title = $2 where id = $1`, [unit, title]);
const tick = (org, unit, portal, wanted = true) =>
  owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, $3, $4)
     on conflict (unit_id, portal) do update set wanted = excluded.wanted`,
    [org, unit, portal, wanted]
  );

before(async () => {
  if (db.skip) return;
  process.env.NEXUS_TOKEN_KEY = "a-test-only-token-key-of-at-least-32-chars";
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  for (const m of ["110-a-unit-goes-on-the-portals.sql", "111-a-key-for-property-finder.sql", "113-a-unit-goes-on-bayut.sql"]) {
    await owner.query(migration(m));
  }
  await owner.query(`delete from organizations where id in ($1, $2)`, [OTHER, SFS]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_active)
     values ($1, 'bys-other', 'BYS Other', '911141', '811141', 'Asia/Dubai', true),
            ($2, 'bys-sfs', 'BYS SFS', '911142', '811142', 'Asia/Dubai', true)`,
    [OTHER, SFS]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, whatsapp_number, brn) values
       ($1, $3, 'BYS1', 'Aisha Khan', 'aisha@sfs.ae', '971501114411', '45678'),
       ($2, $4, 'BYS2', 'Omar Ali', 'omar@other.ae', '971501114412', '45679')`,
    [AISHA, OMAR, SFS, OTHER]
  );
  ready = async (unit, org, agent, location, reference) => {
    await owner.query(
      `insert into property_units (id, organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                   form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                   size_sqft, bathrooms, furnishing, sub_community, building, amenities,
                                   bayut_location_id, bayut_location_name)
       values ($1, $2, 'S9', $3, 'Business Bay', 'apartment', 1, 'rent', 95000,
               '2026-10-28', '71450', '2099-10-27', $4, 'Bright 1-bed with canal view',
               'A bright one-bedroom apartment on a high floor, with a balcony over the canal.',
               812, 2, 'unfurnished', 'Bay Square', 'Building 4', array['balcony'], $5, $6)`,
      [unit, org, reference, agent, location, location ? "UAE › Dubai › Business Bay › Bay Square" : null]
    );
    await owner.query(
      `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size)
       select $1, $2, n, '\\xffd8ff', 2048, 1536, 3 from generate_series(0, 2) n`,
      [org, unit]
    );
  };
  await ready(R, SFS, AISHA, 5002, "Bay Square 4 · 1102");
  await ready(N, SFS, AISHA, null, "Bay Square 4 · 1103");
  await ready(M, SFS, AISHA, 5002, "Bay Square 4 · 1104");
  await ready(P, SFS, AISHA, 5002, "Bay Square 4 · 1105");
  await ready(O, OTHER, OMAR, 5002, "Other · 1");
  await tick(SFS, R, "bayut");
  await tick(SFS, R, "dubizzle");
  await tick(SFS, N, "bayut");
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345'), ($2, '54321')`, [SFS, OTHER]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  sync = await import("../src/services/bayut-sync.ts");
  await lib.saveBayutConnection(SFS, { token: SFS_TOKEN, checkError: null, agencyId: 101, agencyName: "SFS Real Estate - Sandbox" });
  await lib.linkBayutAgent(SFS, AISHA, { bayutUserId: 7, bayutUserName: "Aisha K" });
  await lib.linkBayutAgent(OTHER, OMAR, { bayutUserId: 70, bayutUserName: "Omar A" });
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2)`, [OTHER, SFS]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

test("1. create then publish, the ref written on both rows before the publish; then Bayut's answers, in that order", db, async () => {
  reset();
  let atPublish;
  script.publish = async () => {
    atPublish = { bayut: await row(R, "bayut"), dubizzle: await row(R, "dubizzle") };
  };
  const result = await run();
  assert.deepEqual(made(), [
    "amenities",
    `create ${R}`,
    "publish BY-21 bayut,dubizzle",
    "list 101 1",
    "rejected",
    "show BY-21",
  ]);
  for (const p of ["bayut", "dubizzle"]) {
    assert.equal(atPublish[p].remote_ref, "BY-21", `${p} held the ref before the publish`);
    assert.match(atPublish[p].remote_fingerprint, /^[0-9a-f]{64}$/);
  }
  const body = sent.get(R);
  assert.equal(body.user_id, 7);
  assert.equal(body.location_id, 5002);
  assert.deepEqual(body.amenities, [{ id: "a-1", value: "true" }]);
  for (const p of ["bayut", "dubizzle"]) {
    const r = await row(R, p);
    assert.equal(r.remote_state, "pending", `${p}: asked, and waited for`);
    assert.equal(r.published_at.toISOString(), clock.toISOString());
    assert.equal(r.remote_message, null);
    assert.equal(r.permit_comment, PERMIT_CHECK, "the permit check of a pending unit is read once a cycle");
    assert.equal(r.remote_fingerprint, atPublish.bayut.remote_fingerprint);
    assert.equal(r.wanted, true);
  }
  const kept = redis.kept.get(`bayut-amenities:${SFS}`);
  assert.deepEqual(JSON.parse(kept.value), { balcony: "a-1", shared_gym: "a-2" });
  assert.equal(kept.ex, 86400, "Bayut's amenity ids are kept for a day");
  assert.deepEqual(result, { businesses: 1, steps: 2, failed: 0 });
});

test("2. a unit Bayut cannot take is never sent (no Bayut location); a pending publish is not asked again", db, async () => {
  reset();
  await run();
  assert.deepEqual(made(), ["list 101 1", "rejected", "show BY-21"], "the amenity ids come from Redis");
  assert.ok(!everyCall.some((c) => c.includes(N)), "N was never sent");
  assert.equal((await row(N, "bayut")).remote_state, null);
});

test("3. Bayut makes it live; a changed listing is updated and not republished where live", db, async () => {
  reset();
  bayutSays("BY-21", { bayut: "active", dubizzle: "active" });
  await run();
  assert.deepEqual(writes(), []);
  for (const p of ["bayut", "dubizzle"]) assert.equal((await row(R, p)).remote_state, "live", p);
  const before = (await row(R, "bayut")).remote_fingerprint;
  await retitle(R, "Bright 1-bed, canal view");
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), ["update BY-21"]);
  assert.equal(sent.get("BY-21").title.en, "Bright 1-bed, canal view");
  const [b, d] = [await row(R, "bayut"), await row(R, "dubizzle")];
  assert.notEqual(b.remote_fingerprint, before);
  assert.equal(d.remote_fingerprint, b.remote_fingerprint, "both rows hold what was sent");
  assert.equal(b.remote_state, "live");
  assert.equal(d.remote_state, "live");
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [], "sent once");
});

test("4. unticked → removed, including a pending one; Bayut's list is still read, and a late 'active' is taken off", db, async () => {
  reset();
  await owner.query(`update unit_portals set remote_state = 'pending' where unit_id = $1 and portal = 'dubizzle'`, [R]);
  bayutSays("BY-21", { dubizzle: "draft" });
  await tick(SFS, R, "bayut", false);
  await tick(SFS, R, "dubizzle", false);
  await run();
  assert.deepEqual(made(), ["remove BY-21 bayut,dubizzle", "list 101 1", "rejected"]);
  for (const p of ["bayut", "dubizzle"]) {
    const r = await row(R, p);
    assert.equal(r.remote_state, "unpublished", p);
    assert.equal(r.remote_message, null);
    assert.equal(r.remote_ref, "BY-21", "the ref is kept");
    assert.equal(r.wanted, false);
  }
  calls.length = 0;
  await run();
  assert.deepEqual(made(), ["list 101 1", "rejected"], "nothing to send, but Nexus still reads what Bayut holds of its own");
  // Bayut makes it live after Nexus stopped expecting it: it is seen, and rule 1 takes it off.
  bayutSays("BY-21", { bayut: "active" });
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), []);
  assert.equal((await row(R, "bayut")).remote_state, "live", "what Bayut shows is recorded");
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), ["remove BY-21 bayut"], "and taken off on the next run");
  assert.equal((await row(R, "bayut")).remote_state, "unpublished");
});

test("5. nothing is published twice within 24 hours across two cycles", db, async () => {
  reset();
  await tick(SFS, R, "bayut");
  await tick(SFS, R, "dubizzle");
  await run();
  assert.deepEqual(writes(), [], "published less than a day ago");
  // A publish whose answer is lost may still have reached Bayut: it counts for the guard.
  hoursLater(25);
  script.publish = () => ({ ok: false, kind: "unreachable", message: "HTTP 503" });
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), ["publish BY-21 bayut,dubizzle"]);
  for (const p of ["bayut", "dubizzle"]) {
    const r = await row(R, p);
    assert.equal(r.remote_state, "failed", p);
    assert.equal(r.remote_message, "HTTP 503");
    assert.equal(r.published_at.toISOString(), clock.toISOString(), `${p}: the publish asked is remembered`);
  }
  delete script.publish;
  // Bayut shows dubizzle as a draft: a draft cannot tell a lost publish from one Bayut never received.
  bayutSays("BY-21", { dubizzle: "draft" });
  hoursLater(2);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [], "not published twice within 24 hours");
  for (const p of ["bayut", "dubizzle"]) {
    const r = await row(R, p);
    assert.equal(r.remote_state, "failed", `${p}: inactive or draft, a failed publish stays failed`);
    assert.equal(r.remote_message, "HTTP 503", `${p}: with its words`);
  }
  hoursLater(23);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), ["publish BY-21 bayut,dubizzle"], "a day later it is asked again, once");
  for (const p of ["bayut", "dubizzle"]) {
    const r = await row(R, p);
    assert.equal(r.remote_state, "pending", `${p}: Bayut still shows the old state, but the publish is less than a day old`);
    assert.equal(r.wanted, true, `${p}: not taken for "Bayut took it off"`);
    assert.equal(r.published_at.toISOString(), clock.toISOString());
  }
  bayutSays("BY-21", { bayut: "active", dubizzle: "active" });
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), []);
  for (const p of ["bayut", "dubizzle"]) assert.equal((await row(R, p)).remote_state, "live", p);
});

test("6. Bayut took it off → the switch turns off with the date, and nothing is published", db, async () => {
  reset();
  bayutSays("BY-21", { bayut: "inactive" });
  await run();
  assert.deepEqual(writes(), []);
  const b = await row(R, "bayut");
  assert.equal(b.wanted, false, "switched off, by the system");
  assert.equal(b.changed_by_employee_id, null);
  assert.equal(b.remote_state, "unpublished");
  assert.equal(b.remote_message, `Bayut took it off on ${dayMonth(clock)}`);
  assert.equal((await row(R, "dubizzle")).remote_state, "live", "the other portal is untouched");
  assert.equal((await row(R, "dubizzle")).wanted, true);
  hoursLater(25);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [], "never republished on its own");
  assert.equal((await row(R, "bayut")).remote_message, `Bayut took it off on ${dayMonth(new Date(clock.getTime() - 25 * 3600_000))}`,
    "the words stay while nothing changes");
});

test("6b. ticked again: the unit's job publishes, and a cycle reading Bayut's old 'inactive' does not switch it off (review)", db, async () => {
  reset();
  await tick(SFS, R, "bayut");
  await runUnit(R);
  assert.deepEqual(made(), ["publish BY-21 bayut"]);
  assert.equal((await row(R, "bayut")).remote_state, "pending");
  hoursLater(1);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), []);
  let b = await row(R, "bayut");
  assert.equal(b.remote_state, "pending", "Bayut's list can still show the old state");
  assert.equal(b.wanted, true, "the switch stays on");
  // Still inactive a day after the publish: Bayut took it off.
  hoursLater(24);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [], "never republished on its own");
  b = await row(R, "bayut");
  assert.equal(b.wanted, false);
  assert.equal(b.remote_state, "unpublished");
  assert.equal(b.remote_message, `Bayut took it off on ${dayMonth(clock)}`);
});

test("7. an expired permit takes it off in the same cycle even when the budget is nearly spent", db, async () => {
  reset();
  await tick(SFS, M, "bayut");
  await owner.query(`update property_units set permit_expires_on = '2026-11-01' where id = $1`, [R]);
  let left = 1;
  const budget = { take: async (_org, n) => (left -= n) >= 0, pause: async () => {}, paused: async () => false };
  await run({ budget });
  assert.deepEqual(made(), ["remove BY-21 dubizzle"], "the removal is the call made; M waits for the next cycle");
  assert.equal((await row(R, "dubizzle")).remote_state, "unpublished");
  assert.equal((await row(M, "bayut")).remote_state, null);
  await owner.query(`update property_units set permit_expires_on = '2099-10-27' where id = $1`, [R]);
  calls.length = 0;
  await run();
  assert.ok(writes().includes(`create ${M}`), JSON.stringify(writes()));
  assert.ok(writes().includes("publish BY-22 bayut"), JSON.stringify(writes()));
  assert.equal((await row(M, "bayut")).remote_state, "pending");
  assert.equal((await row(M, "dubizzle")).remote_state, "unpublished", "a portal not wanted is not on Bayut");
  assert.equal((await row(M, "dubizzle")).remote_ref, "BY-22", "but holds the ref, as both rows do");
  // R is ready again and back on dubizzle once Bayut has published it.
  assert.ok(writes().includes("publish BY-21 dubizzle"), JSON.stringify(writes()));
  bayutSays("BY-21", { dubizzle: "active" });
});

test("8. a 422 is refused with Bayut's words and not resent until the listing changes", db, async () => {
  reset();
  await tick(SFS, P, "bayut");
  const WORDS = "The given data was invalid. permit_number: The permit number is not valid.";
  script.create = (body) => (body.reference === P ? { ok: false, kind: "refused", message: WORDS } : undefined);
  await run();
  assert.ok(writes().includes(`create ${P}`));
  let p = await row(P, "bayut");
  assert.equal(p.remote_state, "refused");
  assert.equal(p.remote_message, WORDS);
  assert.match(p.remote_fingerprint, /^[0-9a-f]{64}$/, "what was refused is remembered");
  assert.equal(p.remote_ref, null);
  calls.length = 0;
  await run();
  assert.ok(!writes().some((w) => w.includes(P)), "the same listing is not sent again");
  delete script.create;
  calls.length = 0;
  await run();
  assert.ok(!writes().some((w) => w.includes(P)), "not even once Bayut would take it: it waits for a change");
  await retitle(P, "Bright 1-bed by the canal");
  calls.length = 0;
  await run();
  const ref = await refOf(P);
  assert.deepEqual(writes().filter((w) => w.includes(P) || w.includes(ref)), [`create ${P}`, `publish ${ref} bayut`]);
  p = await row(P, "bayut");
  assert.equal(p.remote_state, "pending");
  assert.equal(p.remote_message, null);
});

test("9. the rejected list marks the unit refused, and it is not sent again until it changes", db, async () => {
  reset();
  const ref = await refOf(P);
  assert.equal((await row(R, "dubizzle")).remote_state, "live");
  rejectedList = [
    { id: ref, reason: "Images are misleading" },
    { id: "BY-999", reason: "A listing Nexus did not make" },
    { id: "BY-21", reason: "An old rejection of a listing Bayut shows active" },
  ];
  const mBefore = await row(M, "bayut");
  await run();
  const p = await row(P, "bayut");
  assert.equal(p.remote_state, "refused");
  assert.equal(p.remote_message, "Images are misleading");
  assert.equal((await row(M, "bayut")).remote_state, mBefore.remote_state, "another unit is untouched");
  assert.equal((await row(R, "dubizzle")).remote_state, "live", "Bayut's word that it is live wins");
  hoursLater(25);
  calls.length = 0;
  await run();
  assert.ok(!writes().some((w) => w.includes(ref)), JSON.stringify(writes()));
  assert.equal((await row(P, "bayut")).remote_state, "refused");
  rejectedList = [];
});

test("9b. a new listing whose first publish never reached Bayut stays failed under Bayut's draft, and is published once a day later (re-review)", db, async () => {
  reset();
  await ready(Q, SFS, AISHA, 5002, "Bay Square 4 · 1106");
  await tick(SFS, Q, "bayut");
  script.publish = () => ({ ok: false, kind: "unreachable", message: "HTTP 503" });
  await run();
  const ref = await refOf(Q);
  assert.deepEqual(writes(), [`create ${Q}`, `publish ${ref} bayut`]);
  assert.equal(store.get(ref).portals.bayut, "draft", "Bayut shows every new listing as a draft");
  let q = await row(Q, "bayut");
  assert.equal(q.remote_state, "failed", "the same cycle's draft does not make it pending");
  assert.equal(q.remote_message, "HTTP 503", "and keeps its words");
  delete script.publish;
  hoursLater(1);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [], "not asked again within the day");
  assert.equal((await row(Q, "bayut")).remote_state, "failed");
  hoursLater(24);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [`publish ${ref} bayut`], "25 hours later it is published, once");
  q = await row(Q, "bayut");
  assert.equal(q.remote_state, "pending");
  assert.equal(q.remote_message, null);
  calls.length = 0;
  await run();
  assert.deepEqual(writes(), [], "and waited for");
});

test("9c. a take-down Bayut does not accept writes nothing, and is tried again (re-review)", db, async () => {
  reset();
  const ref = await refOf(Q);
  bayutSays(ref, { bayut: "active" });
  await run();
  assert.equal((await row(Q, "bayut")).remote_state, "live");
  await tick(SFS, Q, "bayut", false);
  const before = await row(Q, "bayut");
  script.remove = () => ({ ok: false, kind: "refused", message: "The listing is locked." });
  calls.length = 0;
  await runUnit(Q);
  assert.deepEqual(made(), [`remove ${ref} bayut`]);
  const q = await row(Q, "bayut");
  assert.equal(q.remote_state, "live", "the state stays, so rule 1 tries again");
  assert.equal(q.remote_message, before.remote_message, "no words: they could be read as a refused change");
  assert.equal(q.synced_at.toISOString(), before.synced_at.toISOString(), "nothing is written");
  delete script.remove;
  calls.length = 0;
  await run();
  assert.ok(writes().includes(`remove ${ref} bayut`), JSON.stringify(writes()));
  assert.equal((await row(Q, "bayut")).remote_state, "unpublished");
});

test("10. a 429 pauses that business only", db, async () => {
  reset();
  await lib.saveBayutConnection(OTHER, { token: OTHER_TOKEN, checkError: null, agencyId: 202, agencyName: "Other - Sandbox" });
  await tick(OTHER, O, "bayut");
  rateLimited.add("other");
  await run();
  assert.deepEqual(made("other"), ["amenities"], "stopped at Bayut's 429");
  assert.ok(made("sfs").length > 0, "SFS goes on");
  assert.equal(redis.kept.get(`bayut-paused:${OTHER}`).ex, 120, "paused for Bayut's retry_after");
  rateLimited.clear();
  calls.length = 0;
  await run();
  assert.deepEqual(made("other"), [], "no call while paused");
  assert.ok(made("sfs").length > 0, "SFS goes on");
  redis.kept.delete(`bayut-paused:${OTHER}`);
  calls.length = 0;
  await run();
  assert.ok(writes("other").includes(`create ${O}`), JSON.stringify(made("other")));
});

test("11. a refused token stops one business, the other goes on", db, async () => {
  reset();
  await retitle(O, "Other, retitled");
  const before = await row(O, "bayut");
  refusedToken.add("other");
  await run();
  assert.equal(made("other").length, 1, JSON.stringify(made("other")));
  assert.equal((await lib.bayutConnectionView(OTHER)).checkError, "Bayut refused the token: Unauthenticated.");
  const after = await row(O, "bayut");
  assert.equal(after.remote_state, before.remote_state, "nothing is written on the unit");
  assert.equal(after.synced_at.toISOString(), before.synced_at.toISOString());
  assert.ok(made("sfs").length > 0, "SFS goes on");
  calls.length = 0;
  await run();
  assert.deepEqual(made("other"), [], "a refused token is not tried again until it is checked");
});

test("12. one unit's failure does not stop the next", db, async () => {
  reset();
  bayutSays("BY-22", { bayut: "active" });
  await retitle(M, "Two-bed, canal side");
  await retitle(P, "Bright one-bed, canal side");
  const pRef = await refOf(P);
  script.update = (bayutId) => {
    if (bayutId === pRef) throw new Error("socket hang up");
  };
  const result = await run();
  assert.ok(writes().includes(`update ${pRef}`));
  assert.ok(writes().includes("update BY-22"), "M is updated all the same");
  assert.ok(result.failed >= 1);
});

test("13. an update that cannot reach Bayut leaves a live portal live, so nothing is republished", db, async () => {
  reset();
  assert.equal((await row(M, "bayut")).remote_state, "live");
  const before = (await row(M, "bayut")).remote_fingerprint;
  await retitle(M, "Two-bed, canal side, high floor");
  script.update = () => ({ ok: false, kind: "unreachable", message: "HTTP 503" });
  await runUnit(M);
  let m = await row(M, "bayut");
  assert.equal(m.remote_state, "live");
  assert.equal(m.remote_message, null, "not a refusal: the card is not told Bayut refused the change");
  assert.equal(m.remote_fingerprint, before, "the old fingerprint is kept, so it is sent again");
  delete script.update;
  hoursLater(25);
  calls.length = 0;
  await run();
  assert.deepEqual(writes().filter((w) => w.includes("BY-22")), ["update BY-22"], "updated, not republished");
  m = await row(M, "bayut");
  assert.equal(m.remote_state, "live");
  assert.equal(m.remote_message, null);
});

test("13b. a change Bayut refuses on a live or pending listing keeps Bayut's words through the cycle, and is not resent (review)", db, async () => {
  reset();
  const WORDS = "The given data was invalid. price: The price must be at least 1000.";
  const pRef = await refOf(P);
  assert.equal((await row(M, "bayut")).remote_state, "live");
  assert.equal((await row(P, "bayut")).remote_state, "pending");
  await retitle(M, "Two-bed, a change Bayut refuses");
  await retitle(P, "One-bed, a change Bayut refuses");
  script.update = () => ({ ok: false, kind: "refused", message: WORDS });
  await run();
  assert.ok(writes().includes("update BY-22") && writes().includes(`update ${pRef}`), JSON.stringify(writes()));
  assert.ok(made().includes("list 101 1") && made().includes(`show ${pRef}`), "the state list and the permit check both ran");
  let m = await row(M, "bayut");
  const p = await row(P, "bayut");
  assert.equal(m.remote_state, "live");
  assert.equal(m.remote_message, WORDS, "the state list keeps Bayut's words");
  assert.equal(p.remote_state, "pending");
  assert.equal(p.remote_message, WORDS, "the permit check keeps Bayut's words");
  assert.equal(p.permit_comment, PERMIT_CHECK);
  delete script.update;
  calls.length = 0;
  await run();
  assert.ok(!writes().some((w) => w.startsWith("update ")), "the refused change is not resent");
  m = await row(M, "bayut");
  assert.equal(m.remote_message, WORDS, "and the words stay");
});

test("14. a 409 leaves the unit for the next run, writing nothing", db, async () => {
  reset();
  await retitle(M, "Two-bed, canal side, top floor");
  const before = await row(M, "bayut");
  script.update = () => ({ ok: false, kind: "busy", message: "Please wait! Your request is being processed." });
  await runUnit(M);
  const m = await row(M, "bayut");
  assert.equal(m.remote_fingerprint, before.remote_fingerprint);
  assert.equal(m.remote_message, before.remote_message);
  assert.equal(m.synced_at.toISOString(), before.synced_at.toISOString());
  delete script.update;
  calls.length = 0;
  await runUnit(M);
  assert.deepEqual(made(), ["update BY-22"]);
});

test("14b. with many pending units the rejected list is still read, and at most 10 permit checks go to the longest waiting (review)", db, async () => {
  reset();
  const many = Array.from({ length: 12 }, (_, i) => id(31 + i));
  for (const [i, unit] of many.entries()) {
    await ready(unit, SFS, AISHA, 5002, `Bulk · ${i + 1}`);
    await tick(SFS, unit, "bayut");
  }
  const unlimited = { take: async () => true, pause: async () => {}, paused: async () => false };
  const shows = () => made().filter((w) => w.startsWith("show "));
  await run({ budget: unlimited });
  assert.equal(writes().filter((w) => w.startsWith("create ")).length, 12);
  const first = shows();
  assert.equal(first.length, 10, "at most 10 permit checks a cycle");
  assert.ok(made().indexOf("rejected") < made().indexOf(first[0]), "the rejected list is asked before the permit checks");
  // Five calls left: the state list, the rejected list, then three permit checks.
  let left = 5;
  const five = { take: async (_org, n) => (left -= n) >= 0, pause: async () => {}, paused: async () => false };
  calls.length = 0;
  await run({ budget: five });
  assert.deepEqual(made().slice(0, 2), ["list 101 1", "rejected"]);
  const next = shows();
  assert.equal(next.length, 3);
  assert.ok(next.every((s) => !first.includes(s)), `the longest waiting first: ${JSON.stringify(next)} after ${JSON.stringify(first)}`);
});

test("15. a unit's own job works on that unit only and does not read Bayut's lists", db, async () => {
  reset();
  await retitle(M, "Two-bed by the canal");
  await retitle(R, "One-bed by the canal");
  await runUnit(M);
  assert.deepEqual(made(), ["update BY-22"]);
  await lib.clearBayutConnection(SFS);
  calls.length = 0;
  await runUnit(R);
  assert.deepEqual(made(), [], "nothing without a token");
});

const runUnit = (unit) => sync.runBayutUnit(SFS, unit, { client, redis, now: () => clock });
