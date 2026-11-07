// Property Finder records (7 Nov 2026): the business's key and secret are kept
// sealed, with what the last check said; the units the sync must look at are
// the ones wanted on Property Finder or still live there (closed ones too); each
// answer is written on the unit without touching its switch; and the board says
// where the business and each unit stand.
//
// Database cases run against the throwaway Postgres (see the-pf-tables).
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §3, §5, §6
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const SRC = readFileSync(join(root, "packages", "db", "src", "pf-connection.ts"), "utf8");
const M110 = readFileSync(join(root, "packages", "db", "migrations", "110-a-unit-goes-on-the-portals.sql"), "utf8");
const M111 = readFileSync(join(root, "packages", "db", "migrations", "111-a-key-for-property-finder.sql"), "utf8");

function body(name) {
  const start = SRC.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported`);
  const next = SRC.indexOf("\nexport ", start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
}

test("everything runs as the business; only the list of connected businesses looks across them, once", () => {
  for (const name of ["savePfConnection", "recordPfCheck", "clearPfConnection", "pfConnectionView", "pfCredentials", "pfUnitsToSync", "recordPfStep"]) {
    assert.match(body(name), /withTenant\(organizationId,/, name);
    assert.doesNotMatch(body(name), /withAllTenants/, name);
  }
  assert.equal(body("pfBusinesses").match(/withAllTenants\(/g)?.length, 1);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11110000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const OTHER = id(2);
const ASLEEP = id(3); // an inactive business
const AISHA = id(11);
const [A, B, C, D] = [id(21), id(22), id(23), id(24)];
const TZ = "Asia/Dubai";
const asAisha = { employeeId: AISHA, seesAll: false };
const KEY = "pfkey-0000-1a2b";
const SECRET = "pf-secret-value-9";

let owner;
let dbTurn;
let lib;

before(async () => {
  if (db.skip) return;
  process.env.NEXUS_TOKEN_KEY = "a-test-only-token-key-of-at-least-32-chars";
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(M110);
  await owner.query(M111);
  await owner.query(`delete from organizations where id in ($1, $2, $3)`, [SFS, OTHER, ASLEEP]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_active)
     values ($1, 'pfr-sfs', 'PFR SFS', '911111', '811111', 'Asia/Dubai', true),
            ($2, 'pfr-other', 'PFR Other', '911112', '811112', 'Asia/Dubai', true),
            ($3, 'pfr-asleep', 'PFR Asleep', '911113', '811113', 'Asia/Dubai', false)`,
    [SFS, OTHER, ASLEEP]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'PFR1', 'Aisha Khan')`, [AISHA, SFS]);
  await owner.query(
    `insert into property_units (id, organization_id, step, reference, closed_at, closed_reason) values
       ($1, $5, 'S5', 'A · 1', null, null), ($2, $5, 'S5', 'B · 2', null, null),
       ($3, $5, 'S5', 'C · 3', now(), 'withdrawn'), ($4, $5, 'S5', 'D · 4', null, null)`,
    [A, B, C, D, SFS]
  );
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state, remote_fingerprint, synced_at) values
       ($1, $2, 'property_finder', true, null, null, null, null),
       ($1, $3, 'property_finder', true, 'PF-B', 'live', 'fb', '2026-11-07T08:00:00Z'),
       ($1, $4, 'property_finder', false, 'PF-C', 'live', 'fc', '2026-11-07T07:00:00Z'),
       ($1, $5, 'bayut', true, null, null, null, null)`,
    [SFS, A, B, C, D]
  );
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345'), ($2, null), ($3, null)`, [SFS, OTHER, ASLEEP]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2, $3)`, [SFS, OTHER, ASLEEP]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const raw = async (org) =>
  (
    await owner.query(
      `select orn, pf_key_sealed, pf_secret_sealed, pf_key_ending, pf_environment, pf_checked_at, pf_check_error
         from portal_settings where organization_id = $1`,
      [org]
    )
  ).rows[0];

test("1. the key is stored sealed; only its last four characters are readable", db, async () => {
  await lib.savePfConnection(SFS, { key: KEY, secret: SECRET, environment: "sandbox", checkError: null });
  const r = await raw(SFS);
  assert.ok(r.pf_key_sealed && !r.pf_key_sealed.includes(KEY));
  assert.ok(r.pf_secret_sealed && !r.pf_secret_sealed.includes(SECRET));
  assert.notEqual(r.pf_key_sealed, r.pf_secret_sealed);
  assert.equal(r.pf_key_ending, "1a2b");
  assert.equal(r.orn, "12345", "the ORN is left alone");
  assert.deepEqual(await lib.pfCredentials(SFS), { key: KEY, secret: SECRET, environment: "sandbox" });
  const view = await lib.pfConnectionView(SFS);
  assert.deepEqual({ ...view, checkedAt: typeof view.checkedAt }, {
    saved: true, environment: "sandbox", keyEnding: "1a2b", checkedAt: "string", checkError: null,
  });
});

test("2. a check is recorded; a disconnect clears all six and leaves the ORN", db, async () => {
  await lib.recordPfCheck(SFS, "Property Finder refused the key: invalid client");
  assert.equal((await lib.pfConnectionView(SFS)).checkError, "Property Finder refused the key: invalid client");
  await lib.recordPfCheck(SFS, null);
  assert.equal((await lib.pfConnectionView(SFS)).checkError, null);
  await lib.clearPfConnection(OTHER);
  await lib.savePfConnection(OTHER, { key: "other-key-zzzz", secret: "other-secret", environment: "live", checkError: null });
  await lib.clearPfConnection(OTHER);
  const r = await raw(OTHER);
  for (const c of ["pf_key_sealed", "pf_secret_sealed", "pf_key_ending", "pf_environment", "pf_checked_at", "pf_check_error"]) {
    assert.equal(r[c], null, c);
  }
  assert.equal(await lib.pfCredentials(OTHER), null);
  assert.deepEqual(await lib.pfConnectionView(OTHER), { saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null });
});

test("3. only checked keys of active businesses are synced", db, async () => {
  await lib.savePfConnection(OTHER, { key: "other-key-zzzz", secret: "other-secret", environment: "live", checkError: "Property Finder refused the key: no" });
  await lib.savePfConnection(ASLEEP, { key: "asleep-key-yyyy", secret: "asleep-secret", environment: "live", checkError: null });
  const ids = (await lib.pfBusinesses()).map((b) => b.organizationId);
  assert.ok(ids.includes(SFS));
  assert.ok(!ids.includes(OTHER), "a refused key is not synced");
  assert.ok(!ids.includes(ASLEEP), "an inactive business is not synced");
  assert.equal((await lib.pfBusinesses()).find((b) => b.organizationId === SFS).timezone, TZ);
});

test("4. the units to sync: wanted on Property Finder or still live there, closed ones too, never-sent first", db, async () => {
  const units = await lib.pfUnitsToSync(SFS, 10);
  assert.deepEqual(units.map((u) => u.unitId), [A, C, B]);
  assert.deepEqual(units[1].remote, { ref: "PF-C", state: "live", fingerprint: "fc" });
  assert.deepEqual(units[0].remote, { ref: null, state: null, fingerprint: null });
  assert.deepEqual((await lib.pfUnitsToSync(SFS, 2)).map((u) => u.unitId), [A, C]);
  assert.deepEqual(await lib.pfUnitsToSync(OTHER, 10), []);
});

test("5. an answer is written on the unit without touching its switch", db, async () => {
  await lib.recordPfStep(SFS, A, { ref: "PF-A", state: "live", message: null, fingerprint: "fa" });
  let row = (await owner.query(`select * from unit_portals where unit_id = $1 and portal = 'property_finder'`, [A])).rows[0];
  assert.equal(row.wanted, true);
  assert.equal(row.remote_ref, "PF-A");
  assert.equal(row.remote_state, "live");
  assert.equal(row.remote_fingerprint, "fa");
  assert.ok(row.synced_at);
  await lib.recordPfStep(SFS, A, { state: "refused", message: "Price is missing" });
  row = (await owner.query(`select * from unit_portals where unit_id = $1 and portal = 'property_finder'`, [A])).rows[0];
  assert.equal(row.remote_ref, "PF-A", "no ref given keeps the ref");
  assert.equal(row.remote_fingerprint, "fa", "no fingerprint given keeps it");
  assert.equal(row.remote_state, "refused");
  assert.equal(row.remote_message, "Price is missing");
  await lib.recordPfStep(SFS, D, { state: "failed", message: "HTTP 503" });
  row = (await owner.query(`select * from unit_portals where unit_id = $1 and portal = 'property_finder'`, [D])).rows[0];
  assert.equal(row.wanted, false, "a unit with no Property Finder row gets one, switched off");
  assert.equal(row.remote_state, "failed");
});

test("6. the board says where Property Finder stands", db, async () => {
  const board = () => lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha });
  await lib.clearPfConnection(SFS);
  assert.equal((await board()).pfConnection, "none");
  await lib.savePfConnection(SFS, { key: KEY, secret: SECRET, environment: "sandbox", checkError: null });
  assert.equal((await board()).pfConnection, "waiting-format");
  await lib.recordPfCheck(SFS, "Property Finder refused the key: invalid client");
  const b = await board();
  assert.equal(b.pfConnection, "key-refused");
  const a = b.units.find((u) => u.id === A);
  assert.deepEqual({ ...a.portals.property_finder, syncedAt: typeof a.portals.property_finder.syncedAt }, {
    wanted: true, state: "refused", message: "Price is missing", syncedAt: "string",
  });
  assert.deepEqual(a.portals.bayut, { wanted: false, state: null, message: null, syncedAt: null });
});

test("7. a different Property Finder account starts the units afresh; the same one keeps them (final review)", db, async () => {
  const pfRow = async () =>
    (await owner.query(`select wanted, remote_ref, remote_state, remote_message, remote_fingerprint, synced_at from unit_portals where unit_id = $1 and portal = 'property_finder'`, [A])).rows[0];
  await lib.recordPfStep(SFS, A, { ref: "PF-A", state: "live", message: null, fingerprint: "fa" });
  await lib.savePfConnection(SFS, { key: KEY, secret: SECRET, environment: "sandbox", checkError: null });
  assert.equal((await pfRow()).remote_ref, "PF-A", "the same key keeps the units");
  await lib.clearPfConnection(SFS);
  await lib.savePfConnection(SFS, { key: KEY, secret: "a-new-secret", environment: "sandbox", checkError: null });
  assert.equal((await pfRow()).remote_ref, "PF-A", "disconnecting and coming back with the same key keeps them");
  await lib.savePfConnection(SFS, { key: KEY, secret: SECRET, environment: "live", checkError: null });
  const fresh = await pfRow();
  assert.deepEqual(
    { ...fresh, wanted: fresh.wanted },
    { wanted: true, remote_ref: null, remote_state: null, remote_message: null, remote_fingerprint: null, synced_at: null },
    "a Live account knows nothing of the Sandbox listings"
  );
  await lib.recordPfStep(SFS, A, { ref: "PF-A2", state: "live", message: null, fingerprint: "fa2" });
  await lib.savePfConnection(SFS, { key: "another-key-9999", secret: SECRET, environment: "live", checkError: null });
  assert.equal((await pfRow()).remote_ref, null, "another key is another account");
});

test("8. a check that could not reach Property Finder is not a refused key on the board (final review)", db, async () => {
  await lib.recordPfCheck(SFS, "Could not reach Property Finder: HTTP 503");
  const b = await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha });
  assert.equal(b.pfConnection, "check-failed");
  await lib.recordPfCheck(SFS, "Property Finder refused the key: invalid client");
  assert.equal((await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha })).pfConnection, "key-refused");
});
