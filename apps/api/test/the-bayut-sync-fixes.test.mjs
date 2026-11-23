// The Bayut sync after the whole-branch review (24 Nov 2026): an old rejection
// on Bayut's first page never marks a listing staff fixed and sent again
// refused (only one dated at or after the portal's last publish, or any for a
// portal never published, and a live portal only when Bayut's whole state list
// was read); with no amenity map ever read nothing is created or updated, and a
// failed read falls back to the last good map, so no fingerprint moves; the
// time a publish is asked is written before the call; a take-down Bayut answers
// 404 is off; a 403 on a listing is that listing's refusal, never the token's;
// a token Bayut could not be reached to check is checked again each cycle; and
// a run whose Bayut account was replaced under it writes nothing back and
// stops. Bayut is a scripted stand-in (and, for the 403s, the real client on a
// scripted fetch): no test reaches the network.
//
// Database cases run against the throwaway Postgres (see the-bayut-tables).
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §7, §9, §10, §15
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const migration = (name) => readFileSync(join(root, "packages", "db", "migrations", name), "utf8");

/** What the sync logs, kept to read back. */
const logged = [];
const log = (level) => (fields, message) => logged.push({ level, fields, message });
const logger = { info: log("info"), warn: log("warn"), error: log("error"), debug: () => {} };
logger.child = () => logger;
mock.module(new URL("../src/lib/logger.ts", import.meta.url).href, { exports: { logger } });

/** Redis, in memory: the commands the sync uses. */
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
    async incrby() {
      return 1;
    },
    async decrby() {
      return 0;
    },
    async expire() {
      return 1;
    },
  };
}

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11160000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OTHER = id(1);
const SFS = id(2);
const AISHA = id(11);
const OMAR = id(12);
const unit = (n) => id(100 + n);
const SFS_TOKEN = "sfs-sandbox-token-1111-cccc";
const OTHER_TOKEN = "other-sandbox-token-1111-dddd";
const REAL_TOKEN = "sfs-real-account-token-1111-eeee";
const WHO = { [SFS_TOKEN]: "sfs", [OTHER_TOKEN]: "other", [REAL_TOKEN]: "sfs-real" };
const AMENITIES = [{ id: "a-1", title: { en: "Balcony or Terrace" } }];

let clock = new Date("2026-11-24T08:00:00Z");
const hoursLater = (h) => (clock = new Date(clock.getTime() + h * 3600_000));
const iso = (d) => d.toISOString();

/** Bayut, scripted: every call recorded; listings kept with each portal's state. */
const calls = [];
const script = {};
const store = new Map(); // Bayut id → { who, portals }
let rejectedList = [];
let nextId = 601;

async function answer(fn, token, what, args, fallback) {
  calls.push({ who: WHO[token] ?? "nobody", what });
  const s = script[fn];
  if (s) {
    const a = await s(...args);
    if (a !== undefined) return a;
  }
  return fallback();
}
const portalsOf = (bayutId) => Object.entries(store.get(bayutId)?.portals ?? {}).map(([name, state]) => ({ name, state }));
const client = {
  agencies: (token) => answer("agencies", token, "agencies", [], () => ({ ok: true, data: [{ id: 202, parentId: null, name: "Other - Sandbox" }] })),
  users: async () => {
    throw new Error("the sync never reads Bayut's users");
  },
  locations: async () => {
    throw new Error("not a sync call");
  },
  amenities: (token) => answer("amenities", token, "amenities", [], () => ({ ok: true, data: AMENITIES })),
  create: (token, body) =>
    answer("create", token, `create ${body.reference}`, [body], () => {
      const bayutId = `BY-${nextId++}`;
      store.set(bayutId, { who: WHO[token], portals: { bayut: "draft", dubizzle: "draft" } });
      return { ok: true, data: { id: bayutId } };
    }),
  update: (token, bayutId, body) => answer("update", token, `update ${bayutId}`, [bayutId, body], () => ({ ok: true, data: null })),
  publish: (token, bayutId, portals) =>
    answer("publish", token, `publish ${bayutId} ${portals.join(",")}`, [bayutId, portals], () => ({ ok: true, data: null })),
  remove: (token, bayutId, portals) =>
    answer("remove", token, `remove ${bayutId} ${portals.join(",")}`, [bayutId, portals], () => {
      for (const p of portals) if (store.has(bayutId)) store.get(bayutId).portals[p] = "inactive";
      return { ok: true, data: null };
    }),
  show: (token, bayutId) =>
    answer("show", token, `show ${bayutId}`, [bayutId], () => ({ ok: true, data: { portals: portalsOf(bayutId), permit: null } })),
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
const unlimited = { take: async () => true, pause: async () => {}, paused: async () => false };

let redis = fakeRedis();
const run = (extra = {}) => sync.runBayutCycle({ client, redis, budget: unlimited, now: () => clock, ...extra });
const runUnit = (org, u, extra = {}) => sync.runBayutUnit(org, u, { client, redis, budget: unlimited, now: () => clock, ...extra });
const reset = () => {
  calls.length = 0;
  logged.length = 0;
  rejectedList = [];
  for (const k of Object.keys(script)) delete script[k];
};

let owner;
let dbTurn;
let lib;
let sync;
let ready;

const row = async (u, portal) => (await owner.query(`select * from unit_portals where unit_id = $1 and portal = $2`, [u, portal])).rows[0];
const refOf = async (u) => (await row(u, "bayut"))?.remote_ref;
const retitle = (u, title) => owner.query(`update property_units set title = $2 where id = $1`, [u, title]);
const tick = (org, u, portal, wanted = true) =>
  owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, $3, $4)
     on conflict (unit_id, portal) do update set wanted = excluded.wanted`,
    [org, u, portal, wanted]
  );
/** A listing Nexus made earlier, as its row holds it. */
const heldOnBayut = (org, u, portal, bayutId, state, wanted) =>
  owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state, remote_fingerprint, published_at, synced_at)
     values ($1, $2, $3, $4, $5, $6, 'old', '2026-11-20T08:00:00Z', '2026-11-20T08:00:00Z')
     on conflict (unit_id, portal) do update set wanted = excluded.wanted, remote_ref = excluded.remote_ref, remote_state = excluded.remote_state`,
    [org, u, portal, wanted, bayutId, state]
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
     values ($1, 'byf-other', 'BYF Other', '911161', '811161', 'Asia/Dubai', true),
            ($2, 'byf-sfs', 'BYF SFS', '911162', '811162', 'Asia/Dubai', true)`,
    [OTHER, SFS]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, whatsapp_number, brn) values
       ($1, $3, 'BYF1', 'Aisha Khan', 'aisha@sfs.ae', '971501116611', '45678'),
       ($2, $4, 'BYF2', 'Omar Ali', 'omar@other.ae', '971501116612', '45679')`,
    [AISHA, OMAR, SFS, OTHER]
  );
  ready = async (u, org = SFS, agent = AISHA) => {
    await owner.query(
      `insert into property_units (id, organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                   form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                   size_sqft, bathrooms, furnishing, sub_community, building, amenities,
                                   bayut_location_id, bayut_location_name)
       values ($1, $2, 'S9', $3, 'Business Bay', 'apartment', 1, 'rent', 95000,
               '2026-10-28', '71450', '2099-10-27', $4, 'Bright 1-bed with canal view',
               'A bright one-bedroom apartment on a high floor, with a balcony over the canal.',
               812, 2, 'unfurnished', 'Bay Square', 'Building 4', array['balcony'], 5002, 'UAE › Dubai › Business Bay › Bay Square')`,
      [u, org, `Fix · ${u.slice(-3)}`, agent]
    );
    await owner.query(
      `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size)
       select $1, $2, n, '\\xffd8ff', 2048, 1536, 3 from generate_series(0, 2) n`,
      [org, u]
    );
  };
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

// --- I4: the amenity map -------------------------------------------------------

test("1. with no amenity map ever read, nothing is created, updated or published — removals and Bayut's lists still run (I4)", db, async () => {
  reset();
  await ready(unit(1));
  await tick(SFS, unit(1), "bayut");
  await ready(unit(2));
  await heldOnBayut(SFS, unit(2), "bayut", "BY-502", "live", false); // unticked: comes off
  store.set("BY-502", { who: "sfs", portals: { bayut: "active", dubizzle: "inactive" } });
  script.amenities = () => ({ ok: false, kind: "unreachable", message: "HTTP 503" });
  await run();
  assert.deepEqual(made(), ["remove BY-502 bayut", "amenities", "list 101 1", "rejected"]);
  assert.equal((await row(unit(1), "bayut")).remote_state, null, "not sent without its amenities");
  assert.equal((await row(unit(2), "bayut")).remote_state, "unpublished", "the take-down went out");
  calls.length = 0;
  delete script.amenities;
  await run();
  assert.deepEqual(writes().filter((w) => !w.includes("BY-502")), [`create ${unit(1)}`, `publish ${await refOf(unit(1))} bayut`]);
  assert.equal(redis.kept.get(`bayut-amenities:${SFS}`).ex, 86400, "read again once a day");
  const last = redis.kept.get(`bayut-amenities-last:${SFS}`);
  assert.deepEqual(JSON.parse(last.value), { balcony: "a-1" });
  assert.equal(last.ex, null, "the last good map is kept with no expiry");
});

test("2. a failed amenity read falls back to the last good map: no fingerprint moves, nothing is sent again (I4)", db, async () => {
  reset();
  const ref = await refOf(unit(1));
  bayutSays(ref, { bayut: "active" });
  await run();
  assert.equal((await row(unit(1), "bayut")).remote_state, "live");
  const fingerprint = (await row(unit(1), "bayut")).remote_fingerprint;
  // A day later the map is read again, and Bayut cannot answer.
  redis.kept.delete(`bayut-amenities:${SFS}`);
  hoursLater(25);
  script.amenities = () => ({ ok: false, kind: "unreachable", message: "HTTP 503" });
  calls.length = 0;
  await run();
  assert.ok(made().includes("amenities"), "asked, and failed");
  assert.deepEqual(writes(), [], "no update, no publish: the listing did not change");
  assert.equal((await row(unit(1), "bayut")).remote_fingerprint, fingerprint);
  assert.equal((await row(unit(1), "bayut")).remote_state, "live");
});

// --- M3: the time a publish is asked ---------------------------------------------

test("3. the time a publish is asked is written before the call, so a worker stopped mid-call never publishes it again (M3)", db, async () => {
  reset();
  await ready(unit(3));
  await tick(SFS, unit(3), "bayut");
  let atCall;
  script.publish = async (bayutId) => {
    if (store.get(bayutId) && (await refOf(unit(3))) === bayutId) {
      atCall = await row(unit(3), "bayut");
      throw new Error("the worker was stopped");
    }
  };
  await runUnit(SFS, unit(3));
  const ref = await refOf(unit(3));
  assert.deepEqual(writes(), [`create ${unit(3)}`, `publish ${ref} bayut`]);
  assert.equal(atCall.published_at?.toISOString(), iso(clock), "written before Bayut was asked");
  assert.equal(atCall.remote_state, "draft");
  delete script.publish;
  hoursLater(1);
  calls.length = 0;
  await run();
  assert.ok(!writes().some((w) => w.startsWith(`publish ${ref}`)), JSON.stringify(writes()));
  hoursLater(30);
  calls.length = 0;
  await run();
  assert.ok(!writes().some((w) => w.startsWith(`publish ${ref}`)), "a draft with a publish behind it is waited for, never asked again");
});

test("4. a publish Bayut does not take (busy, refused) puts the time back: busy is asked again, refused is not counted (M3)", db, async () => {
  reset();
  await ready(unit(4));
  await tick(SFS, unit(4), "bayut");
  await ready(unit(5));
  await tick(SFS, unit(5), "bayut");
  script.publish = async (bayutId) => {
    if (bayutId === (await refOf(unit(4)))) return { ok: false, kind: "busy", message: "Please wait! Your request is being processed." };
    if (bayutId === (await refOf(unit(5)))) return { ok: false, kind: "refused", message: "The given data was invalid. portal: The portal is not allowed." };
  };
  await run();
  const busy = await row(unit(4), "bayut");
  assert.equal(busy.remote_state, "draft");
  assert.equal(busy.published_at, null, "busy: not counted");
  const refused = await row(unit(5), "bayut");
  assert.equal(refused.remote_state, "refused");
  assert.equal(refused.remote_message, "The given data was invalid. portal: The portal is not allowed.");
  assert.equal(refused.published_at, null, "refused: not counted for the 24-hour guard");
  delete script.publish;
  hoursLater(1);
  calls.length = 0;
  await run();
  assert.ok(writes().includes(`publish ${busy.remote_ref} bayut`), "the busy one is asked again at the next run");
  assert.ok(!writes().some((w) => w.includes(refused.remote_ref)), "the refused one waits for a change");
});

// --- I1: old rejections ------------------------------------------------------------

test("5. an old rejection does not mark a listing staff fixed and sent again refused; one dated after its publish does (I1)", db, async () => {
  reset();
  await ready(unit(6));
  await tick(SFS, unit(6), "bayut");
  await run();
  const ref = await refOf(unit(6));
  const firstPublish = new Date(clock);
  assert.equal((await row(unit(6), "bayut")).remote_state, "pending");
  rejectedList = [{ id: ref, reason: "Images are misleading", at: iso(new Date(firstPublish.getTime() + 3600_000)) }];
  hoursLater(2);
  await run();
  assert.equal((await row(unit(6), "bayut")).remote_state, "refused");
  // Staff fix it a day later; Nexus updates it and publishes it again. Bayut's first page keeps the old rejection.
  hoursLater(25);
  await retitle(unit(6), "Bright 1-bed with canal view, new photos");
  calls.length = 0;
  await run();
  assert.deepEqual(writes().filter((w) => w.includes(ref)), [`update ${ref}`, `publish ${ref} bayut`]);
  const sent = new Date(clock);
  let r = await row(unit(6), "bayut");
  assert.equal(r.remote_state, "pending", "Bayut is checking the new publish");
  assert.equal(r.remote_message, null);
  hoursLater(1);
  calls.length = 0;
  await run();
  r = await row(unit(6), "bayut");
  assert.equal(r.remote_state, "pending", "still: the rejection is older than the publish");
  assert.equal(r.remote_message, null);
  assert.ok(!writes().some((w) => w.includes(ref)), "and nothing is sent");
  // Bayut rejects the new publish too.
  rejectedList.push({ id: ref, reason: "Permit number does not match the unit", at: iso(new Date(sent.getTime() + 1800_000)) });
  hoursLater(1);
  await run();
  r = await row(unit(6), "bayut");
  assert.equal(r.remote_state, "refused");
  assert.equal(r.remote_message, "Permit number does not match the unit");
});

test("6. an undated rejection applies only to a portal never published (I1)", db, async () => {
  reset();
  await ready(unit(7));
  await tick(SFS, unit(7), "bayut");
  await ready(unit(8));
  await tick(SFS, unit(8), "bayut");
  // unit 8's publish is not taken: a draft never published.
  script.publish = async (bayutId) => (bayutId === (await refOf(unit(8))) ? { ok: false, kind: "busy", message: "Wait." } : undefined);
  await run();
  delete script.publish;
  const [ref7, ref8] = [await refOf(unit(7)), await refOf(unit(8))];
  assert.equal((await row(unit(7), "bayut")).remote_state, "pending");
  assert.equal((await row(unit(8), "bayut")).remote_state, "draft");
  rejectedList = [
    { id: ref7, reason: "An undated rejection", at: null },
    { id: ref8, reason: "Images are misleading", at: null },
  ];
  script.publish = async (bayutId) => (bayutId === ref8 ? { ok: false, kind: "busy", message: "Wait." } : undefined);
  hoursLater(1);
  calls.length = 0;
  await run();
  delete script.publish;
  assert.equal((await row(unit(7), "bayut")).remote_state, "pending", "published: an undated rejection cannot be told from an old one");
  const r8 = await row(unit(8), "bayut");
  assert.equal(r8.remote_state, "refused", "never published: any rejection is its own");
  assert.equal(r8.remote_message, "Images are misleading");
});

test("7. a live portal is set refused from the rejected list only when Bayut's whole state list was read; a failed read is logged (I1, M1)", db, async () => {
  reset();
  const ref = await refOf(unit(7));
  bayutSays(ref, { bayut: "active" });
  await run();
  assert.equal((await row(unit(7), "bayut")).remote_state, "live");
  const publishedAt = (await row(unit(7), "bayut")).published_at;
  // Bayut's second page cannot be read; the listing is on it.
  script.list = (_agency, page) =>
    page === 1
      ? { ok: true, data: { items: [], next: true } }
      : { ok: false, kind: "unreachable", message: "HTTP 503" };
  rejectedList = [{ id: ref, reason: "Images are misleading", at: iso(new Date(publishedAt.getTime() + 60_000)) }];
  hoursLater(1);
  logged.length = 0;
  await run();
  assert.equal((await row(unit(7), "bayut")).remote_state, "live", "Bayut may still show it live on the page not read");
  const warned = logged.filter((l) => l.level === "warn" && /state list/.test(l.message));
  assert.equal(warned.length, 1, JSON.stringify(logged));
  assert.deepEqual(warned[0].fields, { organizationId: SFS, page: 2, status: "unreachable", message: "HTTP 503" });
  assert.ok(!JSON.stringify(logged).includes(SFS_TOKEN), "never the token");
  // The whole list read, and the listing not shown active: the rejection stands.
  script.list = () => ({ ok: true, data: { items: [], next: false } });
  hoursLater(1);
  await run();
  const r = await row(unit(7), "bayut");
  assert.equal(r.remote_state, "refused");
  assert.equal(r.remote_message, "Images are misleading");
});

// --- M2, M4: take-downs ---------------------------------------------------------------

test("8. a take-down Bayut answers 404 is recorded off, and not asked again (M2)", db, async () => {
  reset();
  await ready(unit(9));
  await heldOnBayut(SFS, unit(9), "bayut", "BY-509", "live", false);
  script.remove = (bayutId) => (bayutId === "BY-509" ? { ok: false, kind: "refused", message: "Not Found", notFound: true } : undefined);
  await runUnit(SFS, unit(9));
  assert.deepEqual(made(), ["remove BY-509 bayut"]);
  const r = await row(unit(9), "bayut");
  assert.equal(r.remote_state, "unpublished");
  assert.equal(r.remote_message, null);
  calls.length = 0;
  await runUnit(SFS, unit(9));
  assert.deepEqual(made(), [], "nothing left to take down");
});

test("9. a closed card's Bayut listing comes off (M4, spec §15)", db, async () => {
  reset();
  await ready(unit(10));
  await tick(SFS, unit(10), "bayut");
  await tick(SFS, unit(10), "dubizzle");
  await run();
  const ref = await refOf(unit(10));
  bayutSays(ref, { bayut: "active", dubizzle: "active" });
  await run();
  assert.equal((await row(unit(10), "dubizzle")).remote_state, "live");
  await owner.query(`update property_units set closed_at = now(), closed_reason = 'withdrawn' where id = $1`, [unit(10)]);
  calls.length = 0;
  await run();
  assert.ok(writes().includes(`remove ${ref} bayut,dubizzle`), JSON.stringify(writes()));
  for (const p of ["bayut", "dubizzle"]) assert.equal((await row(unit(10), p)).remote_state, "unpublished", p);
});

// --- I6: what a 403 means ------------------------------------------------------------

/** The real client on a scripted fetch: a 403 on the publish and on the take-down. */
async function realClient() {
  const { makeBayutClient } = await import("../src/lib/bayut.ts");
  const asked = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, "");
    asked.push(`${init.method} ${path}`);
    if (init.method === "GET" && path === "/amenities") return reply(200, { data: AMENITIES });
    if (init.method === "POST" && path === "/properties") return reply(201, { data: { id: 7011 } });
    if (init.method === "POST" && path.endsWith("/products/attach")) return reply(403, { message: `Insufficient credits for ${SFS_TOKEN}.` });
    if (init.method === "DELETE") return reply(403, { message: "This user cannot remove the listing." });
    return reply(404, { message: "Not Found" });
  };
  return { client: makeBayutClient(fetchFn), asked };
}

test("10. a 403 on a publish is that listing's refusal, and a 403 on a take-down is retried — the token stays good (I6)", db, async () => {
  reset();
  const real = await realClient();
  await ready(unit(11));
  await tick(SFS, unit(11), "bayut");
  await runUnit(SFS, unit(11), { client: real.client });
  assert.deepEqual(real.asked.filter((a) => !a.startsWith("GET /amenities")), ["POST /properties", "POST /properties/7011/products/attach"]);
  const r = await row(unit(11), "bayut");
  assert.equal(r.remote_state, "refused");
  assert.equal(r.remote_message, "Insufficient credits for •••.", "Bayut's words, the token blanked");
  assert.equal((await lib.bayutConnectionView(SFS)).checkError, null, "not a refused token");
  assert.ok((await lib.bayutBusinesses()).some((b) => b.organizationId === SFS), "the business is still synced");

  await ready(unit(12));
  await heldOnBayut(SFS, unit(12), "bayut", "BY-512", "live", false);
  await runUnit(SFS, unit(12), { client: real.client });
  assert.ok(real.asked.includes("DELETE /properties/BY-512"));
  const held = await row(unit(12), "bayut");
  assert.equal(held.remote_state, "live", "still on Bayut: rule 1 tries again");
  assert.equal(held.remote_message, null, "no words (ruling 12)");
  assert.equal((await lib.bayutConnectionView(SFS)).checkError, null);
  real.asked.length = 0;
  await runUnit(SFS, unit(12), { client: real.client });
  assert.deepEqual(real.asked, ["DELETE /properties/BY-512"], "tried again");
  // Bayut takes it at last (the scripted client): off.
  await runUnit(SFS, unit(12));
  assert.equal((await row(unit(12), "bayut")).remote_state, "unpublished");
});

// --- I6: checked again by the sync ------------------------------------------------------

test("11. a token Bayut could not be reached to check is checked again at the start of a cycle, and synced when it passes (I6)", db, async () => {
  reset();
  await lib.saveBayutConnection(OTHER, { token: OTHER_TOKEN, checkError: null, agencyId: 202, agencyName: "Other - Sandbox" });
  await ready(unit(20), OTHER, OMAR);
  await heldOnBayut(OTHER, unit(20), "bayut", "BY-520", "live", false); // its permit expired, say: comes off
  store.set("BY-520", { who: "other", portals: { bayut: "active" } });
  await lib.recordBayutCheck(OTHER, { checkError: "Could not reach Bayut: HTTP 503", agencyId: null, agencyName: null });
  await run();
  assert.deepEqual(made("other").slice(0, 2), ["agencies", "remove BY-520 bayut"], JSON.stringify(made("other")));
  assert.equal(made("other").filter((w) => w === "agencies").length, 1, "one check");
  assert.equal((await lib.bayutConnectionView(OTHER)).checkError, null);
  assert.equal((await row(unit(20), "bayut")).remote_state, "unpublished");
  assert.equal(made("sfs").includes("agencies"), false, "a business whose check passed is not checked again");
});

test("12. a check again that still cannot reach Bayut is recorded and syncs nothing; a refused token is never checked by itself (I6)", db, async () => {
  reset();
  await lib.recordBayutCheck(OTHER, { checkError: "Could not reach Bayut: timeout", agencyId: null, agencyName: null });
  script.agencies = () => ({ ok: false, kind: "unreachable", message: "HTTP 502" });
  await run();
  assert.deepEqual(made("other"), ["agencies"]);
  assert.equal((await lib.bayutConnectionView(OTHER)).checkError, "Could not reach Bayut: HTTP 502", "what this check said");
  delete script.agencies;
  await lib.recordBayutCheck(OTHER, { checkError: "Bayut refused the token: Unauthenticated.", agencyId: null, agencyName: null });
  calls.length = 0;
  await run();
  assert.deepEqual(made("other"), [], "an admin checks a refused token");
});

test("13. a check again that finds another account turns the switches off and forgets the old account's users (I6)", db, async () => {
  reset();
  await tick(OTHER, unit(20), "bayut");
  await lib.recordBayutCheck(OTHER, { checkError: "Could not reach Bayut: HTTP 503", agencyId: null, agencyName: null });
  await redis.set(`bayut-users:${OTHER}`, JSON.stringify([{ id: 70, name: "Omar A", email: "omar@other.ae" }]), "EX", 604800);
  script.agencies = () => ({ ok: true, data: [{ id: 303, parentId: null, name: "Other Real Estate" }] });
  await run();
  delete script.agencies;
  const r = await row(unit(20), "bayut");
  assert.equal(r.wanted, false);
  assert.equal(r.remote_ref, null);
  assert.equal(redis.kept.get(`bayut-users:${OTHER}`).value, "[]");
  assert.deepEqual(await lib.bayutAgentLinks(OTHER), []);
  assert.equal((await lib.bayutConnectionView(OTHER)).agencyName, "Other Real Estate");
});

// --- I5: the token replaced under a run ------------------------------------------------

test("14. a refused token is recorded only on the token the run used, not on one an admin saved meanwhile", db, async () => {
  reset();
  await ready(unit(30));
  await tick(SFS, unit(30), "bayut");
  script.create = async (body) => {
    if (body.reference !== unit(30)) return undefined;
    // Same account, a new token, saved while the run holds the old one — which Bayut then refuses.
    await lib.saveBayutConnection(SFS, { token: "sfs-sandbox-token-2222-ffff", checkError: null, agencyId: 101, agencyName: "SFS Real Estate - Sandbox" });
    return { ok: false, kind: "token-refused", message: "Unauthenticated." };
  };
  await run();
  assert.equal((await lib.bayutConnectionView(SFS)).checkError, null, "the new token's check stands");
  await lib.saveBayutConnection(SFS, { token: SFS_TOKEN, checkError: null, agencyId: 101, agencyName: "SFS Real Estate - Sandbox" });
});

test("15. a token replaced by another account's in the middle of a run: nothing is written back, nothing more is sent (I5)", db, async () => {
  reset();
  await ready(unit(31));
  await tick(SFS, unit(31), "bayut");
  script.create = async (body) => {
    if (body.reference !== unit(31)) return undefined;
    // An admin pastes the real account's token while Bayut is creating the listing.
    await lib.saveBayutConnection(SFS, { token: REAL_TOKEN, checkError: null, agencyId: 909, agencyName: "SFS Real Estate" });
  };
  await run();
  const sfs = made();
  assert.equal(sfs.at(-1), `create ${unit(31)}`, `the run stops at the write that lands nowhere: ${JSON.stringify(sfs)}`);
  for (const p of ["bayut", "dubizzle"]) {
    const r = await row(unit(31), p);
    if (!r) continue;
    assert.equal(r.remote_ref, null, `${p}: the old account's id is not written back`);
    assert.equal(r.remote_state, null, p);
    assert.equal(r.wanted, false, p);
  }
  const anyHeld = await owner.query(
    `select count(*)::int as n from unit_portals where organization_id = $1 and portal in ('bayut', 'dubizzle') and (remote_ref is not null or wanted)`,
    [SFS]
  );
  assert.equal(anyHeld.rows[0].n, 0, "every row stays cleared");
  assert.ok(logged.some((l) => l.level === "info" && l.fields.why === "the Bayut account changed during this run"), JSON.stringify(logged));
  // The next cycle, on the new account, asks it to take down nothing of the old one's.
  calls.length = 0;
  await run();
  assert.deepEqual(writes("sfs-real"), []);
  assert.deepEqual(writes("sfs"), []);
});
