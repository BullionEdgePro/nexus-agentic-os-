// Authored agent wording, and the one property that makes it dangerous.
//
// Every other stored string on this platform is CONTEXT — the model reads it and
// can work around a bad one. A phrase IS the message: sent verbatim, with no
// model between it and the customer, at the exact moment the platform has
// already decided it cannot answer properly. Nothing downstream catches a
// mistake in it.
//
// So the properties pinned here are the ones whose failure a customer would
// read: an unfilled placeholder going out as `{{open_time}}`, a phrase that
// promises a person at the moment there is nobody, and a lookup that silently
// returns nothing on a shared number and takes the platform default with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PHRASE_MOMENTS,
  unfilledPlaceholders,
  checkPhraseBody,
  isPhraseMoment,
} from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const migrationsDir = join(root, "packages", "db", "migrations");
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), "utf8") }));

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const ROUTE = read("apps", "api", "src", "routes", "phrases.ts");
const PHRASES_DB = read("packages", "db", "src", "phrases.ts");
const CLIENT = read("packages", "db", "src", "client.ts");

const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/**
 * One exported function's body, from its signature to the next export.
 *
 * NOT `[\s\S]*?^}`. That stops at the first line-initial brace, which in this
 * file closes the parameter's inline type — so the first version of the
 * assertions below was reading a signature, finding no `false` in it, and
 * failing for a reason that had nothing to do with the code under test.
 */
function blockFor(source, name) {
  const start = source.indexOf(`export async function ${name}`);
  if (start === -1) return null;
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}
const sqlCode = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

// ============================================================
// The placeholder guard
// ============================================================

test("an unfilled placeholder is found however it is spaced", () => {
  assert.deepEqual(unfilledPlaceholders("we open at {{open_time}}"), ["{{open_time}}"]);
  assert.deepEqual(unfilledPlaceholders("ask {{ team_or_person }} first"), ["{{ team_or_person }}"]);
  assert.deepEqual(unfilledPlaceholders("nothing to fill in here"), []);
  // Deduplicated — "fill in {{x}} and {{x}}" is one blank, mentioned twice.
  assert.equal(unfilledPlaceholders("{{x}} then {{x}}").length, 1);
});

test("a phrase carrying one cannot be switched on", () => {
  // The single most important guard in the feature. Catalogue wording ships
  // with {{open_time}} because the catalogue cannot know when a business opens,
  // and this text is delivered exactly as written.
  const body = code(ROUTE);
  assert.match(body, /unfilledPlaceholders\(current\.body\)/);
  assert.match(body, /if \(unfilled\.length > 0\)/);
  // Named in the message, so the fix is obvious rather than a hunt.
  assert.match(ROUTE, /unfilled\.join\(" and "\)/);
  // And only on the way ON. Refusing to switch one OFF would trap a business
  // with {{open_time}} live and no way to stop it.
  const activateBlock = body.slice(body.indexOf("if (body.isActive)"));
  assert.ok(activateBlock.length > 0, "the guard must sit inside the isActive branch");
});

test("length is bounded in the database, not only in the form", () => {
  // A phrase is delivered as written, so a 4000-character one is a
  // 4000-character WhatsApp message.
  const migration = MIGRATIONS.find((m) => m.file === "045-agent-phrases.sql");
  assert.ok(migration, "045-agent-phrases.sql is missing");
  assert.match(sqlCode(migration.sql), /check \(char_length\(body\) between 20 and 600\)/i);
  assert.equal(checkPhraseBody("too short").ok, false);
  assert.equal(checkPhraseBody("x".repeat(601)).ok, false);
  assert.equal(checkPhraseBody("A perfectly reasonable sentence to send.").ok, true);
});

// ============================================================
// The vocabulary
// ============================================================

test("the moments are only those the reply path already speaks at", () => {
  // A moment nothing detects is wording that is stored, visible, switched on,
  // and never sent. Both of these are reached today by the two constants below.
  assert.deepEqual([...PHRASE_MOMENTS], ["handing_over", "no_one_available"]);
  assert.equal(isPhraseMoment("out_of_hours"), false);

  const body = code(PROCESSOR);
  assert.match(body, /resolvePhrase\(serving\.id, "handing_over", FALLBACK_REPLY\)/);
  assert.match(body, /resolvePhrase\(serving\.id, "no_one_available", FALLBACK_REPLY_NO_STAFF\)/);
  // The AI-failure path too — it is the one that can be EVERY reply for hours.
  assert.match(body, /resolvePhrase\(organization\.id, "handing_over", FALLBACK_REPLY\)/);
});

test("the triage menu is deliberately not a moment", () => {
  // It is sent before the switchboard knows which business the customer wants,
  // so there is no business whose wording it could use.
  assert.ok(!PHRASE_MOMENTS.includes("triage"));
  const shared = read("packages", "shared", "src", "phrases.ts");
  assert.match(shared, /Deliberately NOT here: the triage menu/);
});

// ============================================================
// The reply path must never be made worse by this
// ============================================================

test("the platform defaults survive, and are what a failure falls back to", () => {
  const body = code(PROCESSOR);
  // Both constants still exist. Deleting them in favour of the table would mean
  // a business that has written nothing has nothing to send.
  assert.match(body, /const FALLBACK_REPLY =/);
  assert.match(body, /const FALLBACK_REPLY_NO_STAFF =/);
  // And the resolver falls back on BOTH absence and failure.
  assert.match(body, /if \(!phrase\) return fallback;/);
  assert.match(body, /catch \(err\)[\s\S]{0,200}return fallback;/);
});

test("the lookup reads as the SERVING business", () => {
  // Five businesses share one number, so the pipeline's transaction is scoped to
  // the owner. Read as the owner, RLS matches none of the serving business's
  // rows and the lookup returns nothing — indistinguishable from "none written".
  // That exact mistake has already been made twice on this platform, once in
  // hasStaffOnShift where it answered "you have no staff at all" for four of
  // the five businesses.
  assert.match(
    code(PROCESSOR),
    /withServingTenant\(organizationId, \(\) =>\s*getActivePhrase\(organizationId, moment\)/
  );
});

test("only an active phrase can be sent", () => {
  // A draft is wording nobody agreed to send, and this is the query that would
  // put one in front of a customer.
  const select = blockFor(code(PHRASES_DB), "getActivePhrase");
  assert.ok(select, "getActivePhrase is missing");
  assert.match(select, /and is_active/);
});

test("nothing arrives switched on", () => {
  const body = code(PHRASES_DB);
  for (const fn of ["createPhrase", "materialisePhrase"]) {
    const block = blockFor(body, fn);
    assert.ok(block, `${fn} is missing`);
    assert.match(block, /false/, `${fn} must write is_active false explicitly`);
    assert.ok(!/is_active[^,)]*true/.test(block), `${fn} must not create an active phrase`);
  }
});

// ============================================================
// Isolation and privileges
// ============================================================

test("agent_phrases is tenant-scoped and RLS'd", () => {
  const list = /const TENANT_SCOPED_TABLES = \[([\s\S]*?)\];/.exec(CLIENT);
  assert.match(list[1], /"agent_phrases"/);
  const migration = MIGRATIONS.find((m) => m.file === "045-agent-phrases.sql");
  assert.match(sqlCode(migration.sql), /alter table agent_phrases enable row level security/i);
});

test("the revoke comes before the grant, this time from the start", () => {
  // 039 learned this and applied it to one table; 042 had to finish the job on
  // the next line down. This file does it without being caught first.
  const migration = MIGRATIONS.find((m) => m.file === "045-agent-phrases.sql");
  const sql = sqlCode(migration.sql);
  const revokeAt = sql.indexOf("revoke all on agent_phrases from nexus_app");
  const grantAt = sql.indexOf("grant select, insert, update on agent_phrases to nexus_app");
  assert.ok(revokeAt !== -1 && grantAt !== -1);
  assert.ok(revokeAt < grantAt, "a grant does not remove what an earlier blanket grant placed");
  assert.ok(
    !/grant[^;]*\bdelete\b[^;]*\bon agent_phrases\b/i.test(sql),
    "a phrase that was live is the record of what customers were told"
  );
});

test("one active phrase per moment, enforced by the database", () => {
  const migration = MIGRATIONS.find((m) => m.file === "045-agent-phrases.sql");
  assert.match(
    sqlCode(migration.sql),
    /create unique index[\s\S]*agent_phrases \(organization_id, moment, language\)[\s\S]*where is_active/i
  );
  assert.match(code(PHRASES_DB), /UNIQUE_VIOLATION/);
});

// ============================================================
// The catalogue's wording, which is where this started
// ============================================================

test("catalogue wording names a moment and keeps the no-promise rule", () => {
  const migration = MIGRATIONS.find((m) => m.file === "046-wording-names-its-moment.sql");
  assert.ok(migration, "046-wording-names-its-moment.sql is missing");
  const sql = migration.sql;
  assert.match(sql, /'moment', 'handing_over'/);
  assert.match(sql, /'moment', 'no_one_available'/);

  // THE ONE THAT MATTERS. The no_one_available body must not promise anybody:
  // it is sent precisely when nobody is on shift, and a promise there is the
  // failure that left a conversation abandoned for eleven days.
  const noStaff = /where slug = 'out-of-hours-reply'/.test(sql)
    ? sql.slice(sql.indexOf("'moment', 'no_one_available'"), sql.indexOf("where slug = 'out-of-hours-reply'"))
    : "";
  assert.ok(noStaff.length > 0, "the no_one_available item is missing");
  assert.ok(
    !/someone will come back to you|we.ll get back to you|will follow up/i.test(
      noStaff.split("'notes'")[0]
    ),
    "this moment's wording must not promise that anybody will follow up"
  );

  const service = read("apps", "api", "src", "services", "catalog-activation.ts");
  assert.match(code(service), /isPhraseMoment\(moment\)/);
  assert.ok(
    !/message_templates/.test(code(service)),
    "catalogue wording must never be written to the Meta mirror"
  );
  console.log(`PASS: ${PHRASE_MOMENTS.length} moments, both already spoken at; placeholders cannot go live`);
});
