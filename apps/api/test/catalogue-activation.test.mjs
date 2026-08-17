// Activation materialises; it does not switch anything on.
//
// This is the slice where the catalogue stops being a list and starts writing
// into the tables the agent reads, so the properties worth pinning are the ones
// whose failure would be INVISIBLE — a procedure that arrives live, a pack of
// questions indexed as answers, a template row that looks approved until a
// customer is waiting on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const migrationsDir = join(root, "packages", "db", "migrations");
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), "utf8") }));

const SERVICE = read("apps", "api", "src", "services", "catalog-activation.ts");
const CATALOG_DB = read("packages", "db", "src", "catalog.ts");
const PROCEDURES_DB = read("packages", "db", "src", "procedures.ts");
const ROUTE = read("apps", "api", "src", "routes", "catalog.ts");
const PROCEDURES_PAGE = read("apps", "web", "app", "deck", "procedures", "page.tsx");

const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const sqlCode = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

// ============================================================
// Nothing arrives live
// ============================================================

test("a materialised procedure is written switched off", () => {
  // The single most important line in the slice. A catalogue click that landed
  // an active procedure would change what every future customer of that
  // business is told, from a screen whose whole design says it must not.
  const insert = /insert into procedures[\s\S]*?values\s*\(([^)]*)\)/i.exec(code(CATALOG_DB));
  assert.ok(insert, "the materialise insert is missing");
  assert.match(insert[0], /'catalog'/, "it must record where it came from");
  assert.match(insert[1], /false/, "is_active must be written false, not left to a default");
  assert.ok(
    !/is_active\s*(,|\))?\s*(=\s*)?true/i.test(insert[0]),
    "activation must never write an active procedure"
  );
});

test("the one-active-per-situation rule is left to the database", () => {
  // `activeProcedureFor` exists so the SCREEN can warn. If activation ever
  // started refusing on the strength of that read instead, two clicks could
  // interleave between the read and the write.
  assert.match(code(CATALOG_DB), /export async function activeProcedureFor/);
  assert.match(code(SERVICE), /blockedBySource/);
  const migration = MIGRATIONS.find((m) => m.file === "033-procedures.sql");
  assert.match(sqlCode(migration.sql), /procedures_one_active_per_intent[\s\S]*where is_active/i);
});

test("activating twice cannot write two procedures", () => {
  const fix = MIGRATIONS.find((m) => m.file === "043-catalogue-activation.sql");
  assert.ok(fix, "043-catalogue-activation.sql is missing");
  assert.match(
    sqlCode(fix.sql),
    /create unique index[\s\S]*procedures \(catalog_install_id\)[\s\S]*where catalog_install_id is not null/i
  );
  // And the application leans on it rather than reading first — same argument
  // as 040. `do nothing` plus a read-back means the loser of a race gets the
  // winner's row, not an error.
  assert.match(code(CATALOG_DB), /on conflict \(catalog_install_id\)/);
  assert.match(code(CATALOG_DB), /do nothing/);
  assert.match(code(CATALOG_DB), /neither written nor found/);
});

// ============================================================
// The two refusals, which are findings rather than gaps
// ============================================================

test("a message template becomes a phrase, and never a Meta template row", () => {
  // This USED to refuse, because authored wording had no home. 045 built one.
  // What must not change is where it does NOT go: message_templates mirrors
  // Meta (017), and a local row there is the failure that migration was written
  // to prevent — a send that dies at the last hop after the broadcast, the
  // recipients and the queue jobs all exist.
  const body = code(SERVICE);
  assert.match(body, /kind === "template"/);
  assert.match(body, /materialisePhrase\(/);
  assert.ok(
    !/message_templates/i.test(body),
    "catalogue wording must never be written to the Meta mirror"
  );
  assert.ok(!/insert into message_templates/i.test(code(CATALOG_DB)));

  // Wording still has to name a moment the reply path actually speaks at.
  assert.match(body, /isPhraseMoment\(moment\)/);
  // And it arrives switched off, like everything else activation writes.
  const PHRASES_DB = read("packages", "db", "src", "phrases.ts");
  assert.match(code(PHRASES_DB), /'catalog', false, \$5/);
});

test("a pack of questions is refused rather than indexed as answers", () => {
  // The quiet one. Ingesting the checklist would put nine QUESTIONS into what
  // retrieval searches, and the knowledge screen would show a base fuller than
  // it is — this platform's signature failure in a new coat.
  assert.match(code(SERVICE), /guidance_only/);
  const marker = MIGRATIONS.find((m) => m.file === "044-guidance-packs-are-not-knowledge.sql");
  assert.ok(marker, "044-guidance-packs-are-not-knowledge.sql is missing");
  assert.match(sqlCode(marker.sql), /guidance_only/);
  assert.match(sqlCode(marker.sql), /what-a-business-must-be-able-to-answer/);
  // The item that carries the marker is the one whose own note says its bodies
  // are questions. If 041 is ever reworded so that stops being true, this pins
  // the two together.
  const seed = MIGRATIONS.find((m) => m.file === "041-marketplace-first-items.sql");
  assert.match(seed.sql, /is a QUESTION, not an answer/);
});

test("the refusals are distinguishable by status, not collapsed", () => {
  // "This will never work" and "try again in a minute" need different answers.
  // An embedding outage is temporary; a template having no home is not.
  assert.match(code(ROUTE), /501/);
  assert.match(code(ROUTE), /503/);
  assert.match(code(ROUTE), /embedding-unavailable/);
});

test("a failed pack ingest leaves the install unactivated", () => {
  // Marking it done after a failed embed would report material the agent cannot
  // retrieve — the plausible-normal-state failure again.
  const body = code(SERVICE);
  const catchAt = body.indexOf("} catch (err) {");
  assert.ok(catchAt > 0, "the ingest failure path is missing");
  assert.ok(
    !/markInstallActivated/.test(body.slice(catchAt)),
    "nothing may be marked activated on the failure path"
  );
  assert.match(SERVICE, /has not been half-applied/);
});

// ============================================================
// 'catalog' is a third thing, and everything that reads source knows it
// ============================================================

test("the source vocabulary admits catalog, and the constraint was widened", () => {
  const fix = MIGRATIONS.find((m) => m.file === "043-catalogue-activation.sql");
  assert.match(
    sqlCode(fix.sql),
    /check \(source in \('operator', 'inferred', 'catalog'\)\)/i,
    "the check constraint must allow the new value or every activation fails at the database"
  );
  assert.match(code(PROCEDURES_DB), /"operator" \| "inferred" \| "catalog"/);
});

test("the nightly writer does not defer to a catalogue procedure", () => {
  // Deliberate, and the reason the third value exists at all. If a catalogue
  // row were labelled 'operator', F10 rule 3 would make the writer permanently
  // silent for that situation — a generic pack installed in a minute would
  // switch off this business's learning about that kind of enquiry, for good,
  // and nothing would say so.
  assert.match(code(PROCEDURES_DB), /row\.source === "operator" && row\.isActive/);
  assert.ok(
    !/source === "catalog"/.test(code(PROCEDURES_DB)),
    "the writer must not start treating catalogue rows as authoritative"
  );
});

test("the review screen never calls a catalogue procedure this business's own", () => {
  // It was a binary — operator, or "suggested" — and a catalogue row would have
  // read as this business's own suggestion, with "from 0 conversations" under
  // it. A zero there is evidence that came out empty, not evidence never
  // claimed, and the two mean opposite things to a reviewer.
  const page = code(PROCEDURES_PAGE);
  assert.match(page, /source === "catalog"/);
  assert.match(page, /from the catalogue/);
  assert.match(page, /not drawn from this business/);
});

test("which kinds can be activated is the server's answer, not the page's", () => {
  // Two lists in two applications is how the nav rail and the operator-only
  // guard drifted. The page reads activatableKinds rather than deciding.
  assert.match(code(ROUTE), /activatableKinds:\s*\["procedure", "template", "knowledge_pack"\]/);
  const CATALOGUE_PAGE = read("apps", "web", "app", "deck", "catalogue", "page.tsx");
  assert.match(code(CATALOGUE_PAGE), /activatableKinds\.includes\(item\.kind\)/);
  assert.ok(
    !/kind === "template"/.test(code(CATALOGUE_PAGE)),
    "the page must not hardcode its own view of which kinds work"
  );
  console.log("PASS: activation materialises, never switches on; two refusals are structural");
});
