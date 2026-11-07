// The Property Finder sync (7 Nov 2026): for each business with a working key,
// each unit wanted on Property Finder or still live there gets one step —
// create (then publish), update (then publish), publish, unpublish or nothing —
// and Property Finder's answer is written on the unit. Nothing runs while the
// listing calls are not built; a refused key stops only its own business; one
// unit's failure never stops the next. Property Finder is a scripted stand-in.
//
// Database cases run against the throwaway Postgres (see the-pf-tables).
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §5
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SCHEDULED_JOBS, JOB_STALE_AFTER_SECONDS } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const M110 = readFileSync(join(root, "packages", "db", "migrations", "110-a-unit-goes-on-the-portals.sql"), "utf8");
const M111 = readFileSync(join(root, "packages", "db", "migrations", "111-a-key-for-property-finder.sql"), "utf8");

test("pf-sync is a scheduled job, stale after 45 minutes", () => {
  assert.ok(SCHEDULED_JOBS.includes("pf-sync"));
  assert.equal(JOB_STALE_AFTER_SECONDS["pf-sync"], 2700);
});

test("the fingerprint ignores when the listing changed and the order of its keys", async () => {
  const { pfFingerprint } = await import("../src/services/pf-sync.ts");
  const a = { reference: "u1", title: "Sea view", updatedAt: "2026-11-07T10:00:00.000Z", agent: { name: "A", brn: "1" } };
  const b = { agent: { brn: "1", name: "A" }, updatedAt: "2026-11-08T10:00:00.000Z", title: "Sea view", reference: "u1" };
  assert.equal(pfFingerprint(a), pfFingerprint(b));
  assert.match(pfFingerprint(a), /^[0-9a-f]{64}$/);
  assert.notEqual(pfFingerprint(a), pfFingerprint({ ...a, title: "Sea view!" }));
});

test("the unit job waits 30 seconds and frees its id; nothing is queued while the calls are off", async () => {
  const { queuePfUnit } = await import("../src/queue/pf-sync-queue.ts");
  const added = [];
  const queue = { add: async (...args) => added.push(args) };
  await queuePfUnit("org-1", "unit-1", { queue, ready: true });
  assert.deepEqual(added, [[
    "unit",
    { organizationId: "org-1", unitId: "unit-1" },
    { jobId: "pf-unit-unit-1", delay: 30000, removeOnComplete: true, removeOnFail: true },
  ]]);
  await queuePfUnit("org-1", "unit-1", { queue, ready: false });
  assert.equal(added.length, 1);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11120000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OTHER = id(1); // sorts first: its refused key must not stop SFS
const SFS = id(2);
const AISHA = id(11);
const R = id(21); // ready, wanted on Property Finder
const L = id(22); // closed, still live on Property Finder
const U1 = id(23); // live, switched off — its unpublish throws
const U2 = id(24); // live, switched off
const L2 = id(25); // OTHER's unit, live, switched off
const OTHER_KEY = "other-key-0001";

/** Property Finder, scripted: every call is recorded; `script[fn]` may answer or throw. */
const calls = [];
const script = {};
const client = {
  checkKey: async () => ({ ok: true }),
  createListing: async (c, l) => answer("create", c, l.reference, () => ({ ok: true, ref: `PF-${l.reference.slice(-2)}` })),
  updateListing: async (c, ref) => answer("update", c, ref, () => ({ ok: true })),
  publishListing: async (c, ref) => answer("publish", c, ref, () => ({ ok: true })),
  unpublishListing: async (c, ref) => answer("unpublish", c, ref, () => ({ ok: true })),
};
async function answer(fn, creds, what, fallback) {
  calls.push(`${fn} ${what}`);
  if (creds.key === OTHER_KEY) return { ok: false, kind: "key-refused", message: "invalid client" };
  const s = script[fn];
  if (typeof s === "function") return s(what);
  return fallback();
}
const run = (ready = true) => sync.runPfCycle({ client, ready });
const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(script)) delete script[k];
};

let owner;
let dbTurn;
let lib;
let sync;

const row = async (unit) =>
  (await owner.query(`select * from unit_portals where unit_id = $1 and portal = 'property_finder'`, [unit])).rows[0];

before(async () => {
  if (db.skip) return;
  process.env.NEXUS_TOKEN_KEY = "a-test-only-token-key-of-at-least-32-chars";
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(M110);
  await owner.query(M111);
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pfs-other', 'PFS Other', '911121', '811121', 'Asia/Dubai'),
            ($2, 'pfs-sfs', 'PFS SFS', '911122', '811122', 'Asia/Dubai')`,
    [OTHER, SFS]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, whatsapp_number, brn)
     values ($1, $2, 'PFS1', 'Aisha Khan', 'aisha@sfs.ae', '971501112233', '45678')`,
    [AISHA, SFS]
  );
  await owner.query(
    `insert into property_units (id, organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                 form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                 size_sqft, bathrooms, furnishing, sub_community, building, amenities)
     values ($1, $2, 'S9', 'Bay Square 4 · 1102', 'Business Bay', 'apartment', 1, 'rent', 95000,
             '2026-10-28', '71450', '2099-10-27', $3, 'Bright 1-bed with canal view',
             'A bright one-bedroom apartment on a high floor, with a balcony over the canal.',
             812, 2, 'unfurnished', 'Bay Square', 'Building 4', array['balcony'])`,
    [R, SFS, AISHA]
  );
  for (let i = 0; i < 3; i++) {
    await owner.query(
      `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size) values ($1, $2, $3, '\\xffd8ff', 2048, 1536, 3)`,
      [SFS, R, i]
    );
  }
  await owner.query(
    `insert into property_units (id, organization_id, step, reference, closed_at, closed_reason) values
       ($1, $4, 'S5', 'Closed · 1', now(), 'withdrawn'), ($2, $4, 'S5', 'Off · 1', null, null), ($3, $4, 'S5', 'Off · 2', null, null),
       ($5, $6, 'S5', 'Other · 1', null, null)`,
    [L, U1, U2, SFS, L2, OTHER]
  );
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'property_finder', true)`,
    [SFS, R]
  );
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345'), ($2, null)`, [SFS, OTHER]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  sync = await import("../src/services/pf-sync.ts");
  await lib.savePfConnection(SFS, { key: "sfs-key-0002", secret: "sfs-secret", environment: "sandbox", checkError: null });
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

test("1. nothing runs while the listing calls are not built", db, async () => {
  reset();
  await run(false);
  assert.deepEqual(calls, []);
  assert.equal((await row(R)).remote_state, null);
});

test("2. a ready unit is created and published in one run", db, async () => {
  reset();
  const result = await run();
  assert.deepEqual(calls, ["create " + R, "publish PF-21"]);
  const r = await row(R);
  assert.equal(r.remote_ref, "PF-21");
  assert.equal(r.remote_state, "live");
  assert.equal(r.remote_message, null);
  assert.match(r.remote_fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(r.synced_at);
  assert.equal(r.wanted, true);
  assert.equal(result.steps, 1);
});

test("3. an unchanged unit is not sent again", db, async () => {
  reset();
  await run();
  assert.deepEqual(calls, []);
});

test("4. a changed listing is updated, then published", db, async () => {
  const before = (await row(R)).remote_fingerprint;
  await owner.query(`update property_units set title = 'Bright 1-bed, canal view' where id = $1`, [R]);
  reset();
  await run();
  assert.deepEqual(calls, ["update PF-21", "publish PF-21"]);
  assert.notEqual((await row(R)).remote_fingerprint, before);
});

test("5. a refusal is kept until the listing changes", db, async () => {
  await owner.query(`update property_units set title = 'Bright 1-bed by the canal' where id = $1`, [R]);
  reset();
  script.update = () => ({ ok: false, kind: "refused", message: "Price is too low" });
  await run();
  let r = await row(R);
  assert.equal(r.remote_state, "refused");
  assert.equal(r.remote_message, "Price is too low");
  calls.length = 0;
  await run();
  assert.deepEqual(calls, [], "the same listing is not sent again");
  delete script.update;
  await owner.query(`update property_units set title = 'Bright one-bed by the canal' where id = $1`, [R]);
  await run();
  assert.deepEqual(calls, ["update PF-21", "publish PF-21"]);
  r = await row(R);
  assert.equal(r.remote_state, "live");
  assert.equal(r.remote_message, null);
});

test("6. a failure is retried next cycle", db, async () => {
  await owner.query(`update property_units set title = 'Bright one-bed, canal side' where id = $1`, [R]);
  reset();
  script.publish = () => ({ ok: false, kind: "unreachable", message: "HTTP 503" });
  await run();
  let r = await row(R);
  assert.equal(r.remote_state, "failed");
  assert.equal(r.remote_message, "HTTP 503");
  delete script.publish;
  calls.length = 0;
  await run();
  assert.deepEqual(calls, ["publish PF-21"]);
  r = await row(R);
  assert.equal(r.remote_state, "live");
});

test("7. a unit switched off comes off", db, async () => {
  await owner.query(`update unit_portals set wanted = false where unit_id = $1 and portal = 'property_finder'`, [R]);
  reset();
  await run();
  assert.deepEqual(calls, ["unpublish PF-21"]);
  const r = await row(R);
  assert.equal(r.remote_state, "unpublished");
  assert.equal(r.wanted, false);
});

test("8. a closed unit comes off Property Finder", db, async () => {
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state, remote_fingerprint)
     values ($1, $2, 'property_finder', true, 'PF-L', 'live', 'old')`,
    [SFS, L]
  );
  reset();
  await run();
  assert.deepEqual(calls, ["unpublish PF-L"]);
  assert.equal((await row(L)).remote_state, "unpublished");
});

test("9. a refused key stops only its own business", db, async () => {
  await lib.savePfConnection(OTHER, { key: OTHER_KEY, secret: "other-secret", environment: "live", checkError: null });
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state, synced_at)
     values ($1, $2, 'property_finder', false, 'PF-O', 'live', '2026-11-07T06:00:00Z')`,
    [OTHER, L2]
  );
  await owner.query(`update unit_portals set wanted = true where unit_id = $1 and portal = 'property_finder'`, [R]);
  reset();
  await run();
  assert.deepEqual(calls, ["unpublish PF-O", "publish PF-21"]);
  assert.equal((await lib.pfConnectionView(OTHER)).checkError, "Property Finder refused the key: invalid client");
  const o = await row(L2);
  assert.equal(o.remote_state, "live", "nothing is written on the other business's unit");
  assert.equal(new Date(o.synced_at).toISOString(), "2026-11-07T06:00:00.000Z");
  assert.equal((await row(R)).remote_state, "live");
  calls.length = 0;
  await run();
  assert.ok(!calls.includes("unpublish PF-O"), "a refused key is not tried again until it is checked");
});

test("10. a disconnected business is left alone", db, async () => {
  await owner.query(`update property_units set title = 'Bright one-bed, canal side, high floor' where id = $1`, [R]);
  await lib.clearPfConnection(SFS);
  reset();
  await sync.runPfUnit(SFS, R, { client, ready: true });
  await run();
  assert.deepEqual(calls, []);
  await lib.savePfConnection(SFS, { key: "sfs-key-0002", secret: "sfs-secret", environment: "sandbox", checkError: null });
  await sync.runPfUnit(SFS, R, { client, ready: true });
  assert.deepEqual(calls, ["update PF-21", "publish PF-21"], "one unit's job works on that unit only");
});

test("11. one unit's failure does not stop the next", db, async () => {
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state) values
       ($1, $2, 'property_finder', false, 'PF-U1', 'live'), ($1, $3, 'property_finder', false, 'PF-U2', 'live')`,
    [SFS, U1, U2]
  );
  reset();
  script.unpublish = (ref) => {
    if (ref === "PF-U1") throw new Error("socket hang up");
    return { ok: true };
  };
  const result = await run();
  assert.ok(calls.includes("unpublish PF-U1") && calls.includes("unpublish PF-U2"));
  assert.equal((await row(U2)).remote_state, "unpublished");
  assert.equal((await row(U1)).remote_state, "live", "still live, so it is tried again");
  assert.ok(result.failed >= 1);
});

test("12. an unpublish Property Finder refuses is tried again, not forgotten", db, async () => {
  reset();
  script.unpublish = () => ({ ok: false, kind: "refused", message: "Listing is locked" });
  await run();
  const u1 = await row(U1);
  assert.equal(u1.remote_state, "live");
  assert.equal(u1.remote_message, "Listing is locked");
  delete script.unpublish;
  calls.length = 0;
  await run();
  assert.ok(calls.includes("unpublish PF-U1"));
  assert.equal((await row(U1)).remote_state, "unpublished");
});
