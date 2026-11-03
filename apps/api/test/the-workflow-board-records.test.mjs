// The workflow board's records (3 Nov 2026): a staff member sees the deals of
// their own book and the business's whole inventory; a move lands once, on the
// step it set out from; the rules refuse what they refuse before anything is
// written; and every change leaves its line in the history.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration), seeded as the owner
// and acting as `nexus_app` through @nexus/db:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55434/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55434/nexus
//
// Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §3, §5
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const SRC = readFileSync(join(root, "packages", "db", "src", "workflow-board.ts"), "utf8");
const MIGRATION = readFileSync(join(root, "packages", "db", "migrations", "107-the-workflow-board.sql"), "utf8");

/** The source of one exported function, up to the next export. */
function body(name) {
  const start = SRC.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported`);
  const next = SRC.indexOf("\nexport ", start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
}

const READS = ["getBoard", "cardHistory"];
const LOGGED = ["createUnit", "moveUnit", "closeUnit", "createDeal", "moveDeal", "closeDeal"];
const WRITES = [...LOGGED, "updateUnit", "updateDeal", "linkUnit", "unlinkUnit"];

test("every read and write runs inside the business's tenant scope", () => {
  for (const name of [...READS, ...WRITES]) assert.match(body(name), /withTenant\(organizationId,/, name);
});

test("every create, move and close writes its history line in the same transaction", () => {
  for (const name of LOGGED) assert.match(body(name), /logMove\(/, name);
  assert.match(SRC, /insert into workflow_moves/);
  // A move lands only on the step it set out from, and never on a closed card.
  for (const name of ["moveUnit", "moveDeal"]) {
    assert.match(body(name), /and step = \$\d+ and closed_at is null/, name);
  }
});

test("dates come back as the day written, never as a time in someone's zone", () => {
  for (const col of ["form_a_signed_on", "permit_expires_on", "form_f_signed_on", "dld_transfer_on"]) {
    assert.match(SRC, new RegExp(`\\b\\w+\\.${col}::text`), col);
  }
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `10730000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const OTHER = id(2);
const THIRD = id(3);
const STAFF_A = id(11); // Aisha
const STAFF_B = id(12); // Bilal
const CA = id(21); // in Aisha's book
const CA2 = id(22); // in Aisha's book, worked by Bilal
const CB = id(23); // in Bilal's book
const CH = id(24); // a hot lead in Aisha's book
const CR = id(25); // the other firm's customer, served by SFS on a shared number
const CT = id(26); // a third firm's customer SFS has never served
const TZ = "Asia/Dubai";

const aisha = { employeeId: STAFF_A };
const bilal = { employeeId: STAFF_B };
const asAisha = { employeeId: STAFF_A, seesAll: false };
const asBilal = { employeeId: STAFF_B, seesAll: false };
const asOperator = { employeeId: null, seesAll: true };
const asPreview = { employeeId: null, seesAll: false };

let owner;
let dbTurn;
let lib;

const dubaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(MIGRATION);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'wbr-sfs', 'Records SFS', '910731', '810731', 'Asia/Dubai'),
            ($2, 'wbr-other', 'Records Other', '910732', '810732', 'Asia/Dubai'),
            ($3, 'wbr-third', 'Records Third', '910733', '810733', 'Asia/Dubai')`,
    [SFS, OTHER, THIRD]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name) values ($1, $3, 'WR1', 'Aisha'), ($2, $3, 'WR2', 'Bilal')`,
    [STAFF_A, STAFF_B, SFS]
  );
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, display_name, owner_employee_id) values
       ($1, $7, '971507300001', 'Lead A', $8),
       ($2, $7, '971507300002', 'Lead A two', $8),
       ($3, $7, '971507300003', 'Owner B', $9),
       ($4, $7, '971507300004', 'Hot lead', $8),
       ($5, $10, '971507300005', 'Routed lead', $8),
       ($6, $11, '971507300006', 'Third firm lead', null)`,
    [CA, CA2, CB, CH, CR, CT, SFS, STAFF_A, STAFF_B, OTHER, THIRD]
  );
  await owner.query(`update contacts set served_organization_ids = array[$1::uuid, $2::uuid] where id = $3`, [OTHER, SFS, CR]);
  await owner.query(
    `insert into lead_assessments (organization_id, contact_id, score, priority, category) values ($1, $2, 90, 'high', 'buyer')`,
    [SFS, CH]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from lead_assessments where organization_id in ($1, $2, $3)`, [SFS, OTHER, THIRD]);
  await owner.query(`delete from organizations where id in ($1, $2, $3)`, [SFS, OTHER, THIRD]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const board = (viewer) => lib.getBoard({ organizationId: SFS, timezone: TZ, viewer });
const movesOf = async (column, cardId) =>
  (await owner.query(`select kind, from_step, to_step, by_employee_id from workflow_moves where ${column} = $1 order by at, kind`, [cardId])).rows;

let dealA; // Lead A, rent
let dealB; // Owner B, sale
let unitU1;

test("1. a staff member sees their own book's deals and the whole inventory", db, async () => {
  dealA = await lib.createDeal(SFS, aisha, asAisha, { contactId: CA, purpose: "rent" });
  assert.equal(dealA.step, "D4");
  assert.equal(dealA.agent?.name, "Aisha");
  dealB = await lib.createDeal(SFS, bilal, asBilal, { contactId: CB, purpose: "sale", step: "D3" });
  const ownersUnit = await lib.createUnit(SFS, bilal, asBilal, { reference: "Bilal's listing", ownerContactId: CB });
  assert.equal(ownersUnit.owner?.name, "Owner B");

  const mine = await board(asAisha);
  assert.deepEqual(mine.deals.map((d) => d.contact.name), ["Lead A"]);
  assert.equal(mine.hidden.D3, 1);
  const theirs = mine.units.find((u) => u.id === ownersUnit.id);
  assert.equal(theirs.owner.contactId, CB);
  assert.equal(theirs.owner.name, null);
  assert.equal(theirs.agent.name, "Bilal");

  assert.equal((await board(asBilal)).units.find((u) => u.id === ownersUnit.id).owner.name, "Owner B");
  assert.deepEqual((await board(asOperator)).deals.map((d) => d.contact.name).sort(), ["Lead A", "Owner B"]);
  assert.deepEqual(Object.keys((await board(asOperator)).hidden), []);

  // "View as staff" names nobody, so it holds no book: units, counts, no deals.
  const preview = await board(asPreview);
  assert.equal(preview.deals.length, 0);
  assert.equal(preview.hidden.D4, 1);
  assert.ok(preview.units.length >= 1);
});

test("1b. a colleague's client cannot be put on the board, or named as an owner, by id (final review)", db, async () => {
  // The unit card hands every staff member Bilal's client's contact id; it must open nothing.
  assert.equal(await lib.createDeal(SFS, aisha, asAisha, { contactId: CB, purpose: "rent" }), "no-contact");
  assert.equal(await lib.createDeal(SFS, aisha, asAisha, { contactId: CB, purpose: "sale" }), "no-contact"); // not "duplicate"
  assert.equal(await lib.createUnit(SFS, aisha, asAisha, { reference: "Probe", ownerContactId: CB }), "no-contact");
  const mine = await lib.createUnit(SFS, aisha, asAisha, { reference: "Aisha's listing" });
  assert.equal(await lib.updateUnit(SFS, aisha, asAisha, mine.id, { ownerContactId: CB }), "no-contact");
  // The operator still can.
  const forBilal = await lib.createDeal(SFS, bilal, asOperator, { contactId: CB, purpose: "rent" });
  assert.equal(forBilal.contact.name, "Owner B");
  await lib.closeDeal(SFS, bilal, asOperator, forBilal.id, "lost", null);
});

test("2. a deal follows its customer's book, unless it is assigned to you", db, async () => {
  // Nobody named: the deal is worked by whoever holds the customer — shown, not stored (final review).
  const worked = await lib.createDeal(SFS, aisha, asAisha, { contactId: CA2, purpose: "sale" });
  assert.equal(worked.agent?.name, "Aisha");
  assert.ok((await board(asAisha)).deals.some((d) => d.id === worked.id));
  await owner.query(`update contacts set owner_employee_id = $1 where id = $2`, [STAFF_B, CA2]);
  assert.ok(!(await board(asAisha)).deals.some((d) => d.id === worked.id));
  const withBilal = (await board(asBilal)).deals.find((d) => d.id === worked.id);
  assert.equal(withBilal?.agent?.name, "Bilal");
  // Named on purpose, it stays with the one named, whoever's book the customer is in.
  await lib.updateDeal(SFS, bilal, asBilal, worked.id, { agentEmployeeId: STAFF_A });
  assert.equal((await board(asAisha)).deals.find((d) => d.id === worked.id)?.agent?.name, "Aisha");
  assert.ok((await board(asBilal)).deals.some((d) => d.id === worked.id));
  // Aisha's own deal stays hers: it is in her book.
  assert.ok((await board(asAisha)).deals.some((d) => d.id === dealA.id));
});

test("3. a hot lead waits until somebody puts it on the board", db, async () => {
  const before = await board(asAisha);
  assert.deepEqual(before.hotWaiting.map((h) => [h.contactId, h.name, h.priority]), [[CH, "Hot lead", "high"]]);
  assert.deepEqual((await board(asBilal)).hotWaiting, []);
  await lib.createDeal(SFS, aisha, asAisha, { contactId: CH, purpose: "sale" });
  assert.deepEqual((await board(asAisha)).hotWaiting, []);
});

test("4. a move lands once, on the step it set out from, and classifies a unit", db, async () => {
  unitU1 = await lib.createUnit(SFS, aisha, asAisha, { reference: "Marina Gate 2 · 1204" });
  assert.equal(unitU1.step, "S5");
  assert.equal(unitU1.agent?.name, "Aisha");
  const first = await lib.moveUnit(SFS, TZ, aisha, asAisha, unitU1.id, "S5", "S6");
  assert.equal(first.ok.step, "S6");
  assert.equal(first.ok.purpose, "rent");
  assert.ok(Date.now() - Date.parse(first.ok.inStepSince) < 60_000);
  assert.deepEqual(await lib.moveUnit(SFS, TZ, bilal, asBilal, unitU1.id, "S5", "S6"), { moved: "S6" });
  const moves = await movesOf("unit_id", unitU1.id);
  assert.deepEqual(
    moves.map((m) => [m.kind, m.from_step, m.to_step, m.by_employee_id]),
    [
      ["created", null, "S5", STAFF_A],
      ["moved", "S5", "S6", STAFF_A],
    ]
  );
});

test("5. no advertising without a permit, and nothing written when refused", db, async () => {
  const refused = await lib.moveUnit(SFS, TZ, aisha, asAisha, unitU1.id, "S6", "S9");
  assert.deepEqual(refused, {
    refused: "Before it can be advertised: Form A signed date, Trakheesi permit number, permit expiry date.",
  });
  assert.equal((await movesOf("unit_id", unitU1.id)).length, 2);
  const filled = await lib.updateUnit(SFS, aisha, asAisha, unitU1.id, {
    formASignedOn: "2026-10-01",
    permitNumber: "71234",
    permitExpiresOn: "2030-01-31",
  });
  assert.equal(filled.permitExpiresOn, "2030-01-31");
  assert.equal((await lib.moveUnit(SFS, TZ, aisha, asAisha, unitU1.id, "S6", "S9")).ok.step, "S9");
  // Taking the permit off an advertised unit is refused, not saved.
  assert.deepEqual(await lib.updateUnit(SFS, aisha, asAisha, unitU1.id, { permitNumber: " " }), {
    refused: "An advertised unit keeps its Form A date, Trakheesi permit number and permit expiry.",
  });
});

test("6. a permit that lapsed while advertised is still on the board, against the business's own date", db, async () => {
  const { rows } = await owner.query(
    `insert into property_units (organization_id, step, reference, purpose, form_a_signed_on, permit_number, permit_expires_on)
     values ($1, 'S10', 'Lapsed listing', 'sale', '2026-01-01', '70001', ((now() at time zone 'Asia/Dubai')::date - 1)) returning id`,
    [SFS]
  );
  const b = await board(asAisha);
  assert.equal(b.today, dubaiToday());
  const lapsed = b.units.find((u) => u.id === rows[0].id);
  assert.ok(lapsed);
  assert.ok(lapsed.permitExpiresOn < b.today);
});

test("7. one open deal per lead and purpose", db, async () => {
  assert.equal(await lib.createDeal(SFS, aisha, asAisha, { contactId: CA, purpose: "rent" }), "duplicate");
});

test("8. a shared-number customer can go on the board; a stranger cannot", db, async () => {
  const routed = await lib.createDeal(SFS, aisha, asAisha, { contactId: CR, purpose: "rent" });
  assert.equal(routed.contact.name, "Routed lead");
  assert.equal(routed.agent?.name, "Aisha");
  assert.ok((await board(asAisha)).deals.some((d) => d.id === routed.id));
  assert.equal(await lib.createDeal(SFS, aisha, asAisha, { contactId: CT, purpose: "rent" }), "no-contact");
  assert.equal(await lib.createUnit(SFS, aisha, asAisha, { reference: "X", ownerContactId: CT }), "no-contact");
});

test("9. a deal is won only at the end, and the win is counted", db, async () => {
  assert.deepEqual(await lib.closeDeal(SFS, bilal, asBilal, dealB.id, "won", null), {
    refused: "A deal closes as Won from Rent deal, Sale deal or CRM & commission.",
  });
  // Aisha cannot reach Bilal's deal at all.
  assert.equal(await lib.closeDeal(SFS, aisha, asAisha, dealB.id, "lost", null), null);
  assert.equal((await lib.moveDeal(SFS, TZ, aisha, asAisha, dealA.id, "D4", "D9")).ok.step, "D9");
  await lib.updateDeal(SFS, aisha, asAisha, dealA.id, { dealValueAed: 120000, commissionAed: 5000 });
  assert.deepEqual(await lib.closeDeal(SFS, aisha, asAisha, dealA.id, "won", "Signed today"), { ok: true });
  assert.deepEqual(await lib.closeDeal(SFS, aisha, asAisha, dealA.id, "lost", null), { closed: true });
  assert.deepEqual(await lib.moveDeal(SFS, TZ, aisha, asAisha, dealA.id, "D9", "D4"), { closed: true });
  const b = await board(asOperator);
  assert.equal(b.closed30.won, 1);
  assert.equal(b.closed30.commissionAed, 5000);
  assert.ok(!b.deals.some((d) => d.id === dealA.id));
});

test("10. the history reads in order, with names", db, async () => {
  const history = await lib.cardHistory(SFS, asAisha, "deal", dealA.id);
  assert.deepEqual(
    history.map((m) => [m.kind, m.from, m.to, m.closedReason, m.by]),
    [
      ["created", null, "D4", null, "Aisha"],
      ["moved", "D4", "D9", null, "Aisha"],
      ["closed", "D9", null, "won", "Aisha"],
    ]
  );
  assert.equal(await lib.cardHistory(SFS, asAisha, "deal", dealB.id), null);
});

test("11. units matched to a deal, and only to a deal you can see", db, async () => {
  const deal = (await board(asAisha)).deals.find((d) => d.contact.name === "Hot lead");
  const linked = await lib.linkUnit(SFS, aisha, asAisha, deal.id, unitU1.id);
  assert.deepEqual(linked.unitIds, [unitU1.id]);
  assert.deepEqual((await board(asAisha)).units.find((u) => u.id === unitU1.id).dealIds, [deal.id]);
  assert.deepEqual((await board(asBilal)).units.find((u) => u.id === unitU1.id).dealIds, []);
  assert.equal(await lib.linkUnit(SFS, aisha, asAisha, dealB.id, unitU1.id), null);
  assert.deepEqual((await lib.unlinkUnit(SFS, aisha, asAisha, deal.id, unitU1.id)).unitIds, []);
});
