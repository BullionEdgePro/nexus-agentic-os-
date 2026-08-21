// Six writers, one boolean, and no record of which one fired.
//
// `conversations.is_human_handoff` said THAT a conversation was held by a
// person. It never said by whom, when, or why — and the moment it flipped back,
// the fact it had ever been held was gone.
//
// WHAT THAT ABSENCE COST, on 2026-08-20: a customer waiting 28 hours, the flag
// reading false, and customer-waiting therefore saying "the AI was not paused,
// so it should have answered — check the reply pipeline". An afternoon went
// into chasing a reply pipeline that was working perfectly. The truth was a
// colleague who answered on the 10th, a customer who wrote again on the 19th
// while the flag was still set, and a flag cleared afterwards by something
// nothing recorded. Reconstructing it took message timestamps, the git log and
// a guess. It is now one query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "conversations.ts");
const MIGRATION = read(
  "packages",
  "db",
  "migrations",
  "062-a-conversation-changing-hands-is-an-event.sql"
);

test("the reason is required, not optional", () => {
  // This is the whole design. An optional reason is a reason nobody supplies,
  // and a seventh writer would add itself silently.
  const sig = DB.slice(
    DB.indexOf("export async function setConversationHandoff"),
    DB.indexOf("): Promise<void> {", DB.indexOf("export async function setConversationHandoff"))
  );
  assert.match(sig, /reason: CustodyReason/);
  assert.ok(
    !/reason\?: CustodyReason/.test(sig),
    "an optional reason is a reason nobody supplies"
  );
});

test("the trace is written by the setter, not by its callers", () => {
  // An audit trail every caller has to remember is a convention, and this
  // codebase has spent nine defects learning what a convention is worth.
  const body = DB.slice(DB.indexOf("export async function setConversationHandoff"));
  assert.match(body.slice(0, body.indexOf("\n}")), /insert into conversation_custody/);
});

test("no caller writes the custody table directly", () => {
  // A caller that inserts its own row can insert one that disagrees with the
  // flag, which is worse than no row at all.
  const dir = join(root, "apps", "api", "src");
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".ts")) continue;
      if (/insert into conversation_custody/.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(dir);
  assert.deepEqual(offenders, [], "custody rows must only be written by setConversationHandoff");
});

test("every writer states a reason the schema allows", () => {
  // A value that exists only in TypeScript would be refused by the CHECK
  // constraint at runtime — on the one code path nobody exercises in tests.
  const allowed = new Set(
    [...MIGRATION.matchAll(/'(agent_escalated|human_replied|taken_by_employee|manual_toggle|stale_release)'/g)].map(
      (m) => m[1]
    )
  );
  assert.equal(allowed.size, 5, "could not read the reason vocabulary from migration 062");

  // The union in TypeScript must match the constraint exactly, in both
  // directions — a union member the schema rejects is a runtime failure, and a
  // schema value the union forbids is a reason nobody can give.
  const union = DB.slice(DB.indexOf("export type CustodyReason"), DB.indexOf(";", DB.indexOf("export type CustodyReason")));
  const declared = new Set([...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...declared].sort(), [...allowed].sort());

  for (const file of ["queue/processor.ts", "routes/conversations.ts", "routes/employees.ts"]) {
    const src = read("apps", "api", "src", ...file.split("/"));
    for (const m of src.matchAll(/setConversationHandoff\([^)]*?,\s*(?:true|false|[\w.]+),\s*"([a-z_]+)"/gs)) {
      assert.ok(allowed.has(m[1]), `${file} uses "${m[1]}", which the schema would refuse`);
    }
  }
});

test("a flag that does not change writes no row", () => {
  // A held conversation receives a message every time the customer writes, and
  // each one calls this. Without the guard the table accrues a row per message
  // and stops being a history of anything.
  const body = DB.slice(DB.indexOf("export async function setConversationHandoff"));
  assert.match(body, /is_human_handoff is distinct from \$2/);
  // And the row comes FROM the update's own output, so the two cannot disagree.
  assert.match(body, /returning id, organization_id/);
  assert.match(body, /select organization_id, id, \$2, \$3, \$4 from changed/);
});

test("nothing is backfilled, and the reader says why that matters", () => {
  // Inventing history from message senders would produce something that looks
  // authoritative and is guessed. The absence is at least honest — but only if
  // readers are told not to read it as "never held".
  assert.match(MIGRATION, /NO BACKFILL, DELIBERATELY/);
  assert.ok(
    !/insert into conversation_custody\s*\(?\s*select/i.test(MIGRATION),
    "migration 062 backfills, which would fabricate a history"
  );
  const reader = DB.slice(DB.indexOf("export async function listCustody"));
  assert.match(DB.slice(0, DB.indexOf("export async function listCustody")).slice(-1200) + reader.slice(0, 200), /NOT RECORDED/);
});

test("the table is tenant-scoped like conversations themselves", () => {
  assert.match(MIGRATION, /enable row level security/);
  assert.match(MIGRATION, /organization_id::text = current_setting\('app\.current_org', true\)/);
  // Owner-scoped, not serving-scoped: filing a routed conversation's custody
  // under the serving business would split one history across two tenants and
  // neither half would read correctly alone.
  assert.ok(
    !/serving_organization_id/.test(MIGRATION),
    "custody must follow the conversation's owner, as conversations do"
  );
});
