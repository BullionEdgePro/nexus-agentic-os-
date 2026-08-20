// A business serving a conversation could not send a message into it.
//
// Migration 054 widened the `using` clauses so a serving firm can READ the
// conversation it is answering, and left `with check` owner-only. Measured
// adversarially against production as Juris Prime, on a conversation routed to
// Juris Prime:
//
//   UPDATE that conversation                REFUSED   (correct)
//   INSERT a reply into it                  REFUSED   <- the finding
//   the same INSERT as the number's owner   allowed
//   the same INSERT cross-tenant            allowed
//
// The last line is the whole problem. The deck's reply path works today only
// because `/api/conversations/:id/...` carries no `:slug`, so tenantContext
// gives it a cross-tenant context and the policy never applies. Replying to
// your own customer -- the core action of this product -- was permitted by an
// accident of URL SHAPE, and would have stopped working the day that route
// moved under `/api/organizations/:slug/...` like every other per-business one.
//
// Verified again after migration 058, all four as intended:
//
//   reply into a conversation juris-prime serves      INSERT 0 1
//   reply into one of zipicka's own conversations     refused
//   forge serving_organization_id to smuggle a row    refused
//   re-route a conversation juris-prime serves        refused
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const M058 = read("packages", "db", "migrations", "058-a-firm-may-answer-its-own-customer.sql");
const M054 = read("packages", "db", "migrations", "054-routed-traffic-belongs-to-the-serving-business.sql");

/** One policy statement, bounded so an assertion cannot match its neighbour. */
function policy(sql, name) {
  const start = sql.indexOf(`create policy ${name}`);
  assert.ok(start > -1, `${name} not found`);
  const end = sql.indexOf(";", sql.indexOf("with check", start));
  return sql.slice(start, end);
}

test("a firm may write a message into a conversation it serves", () => {
  const p = policy(M058, "messages_tenant_isolation");
  const check = p.slice(p.indexOf("with check ("));
  assert.match(check, /serving_organization_id::text = current_setting\('app\.current_org', true\)/);
});

test("and still may not re-route the customer", () => {
  // Different question, different answer. A message is the firm talking to its
  // own customer; a conversation carries WHICH firm is answering, and changing
  // that is the switchboard's decision. The switchboard runs as the owner.
  const p = policy(M054, "conversations_tenant_isolation");
  const check = p.slice(p.indexOf("with check ("));
  assert.ok(
    !check.includes("routed_organization_id"),
    "routing must stay owner-only, or a firm can claim another's customer"
  );
  // 058 asserts this itself at apply time, so a later migration widening
  // conversations fails loudly rather than being noticed here months later.
  assert.match(M058, /conversations became writable by a serving business/);
});

test("the granted value cannot be chosen by the writer", () => {
  // The check reads serving_organization_id, which migration 054 fills from the
  // conversation in a BEFORE INSERT trigger. WITH CHECK runs on the final row,
  // after triggers -- so a forged value is overwritten with the true one and
  // then refused by the check. Probe 3 above is that attempt, and it failed.
  assert.match(M054, /before insert or update of conversation_id on messages/);
  assert.match(M058, /after triggers/);
});

test("the migration does not pretend to verify its own policy", () => {
  // Migrations run as the owner, who bypasses row-level security -- so a probe
  // inside one reports the same thing whether the policy is right, wrong or
  // absent. Migration 056 shipped exactly that mistake. This checks the SHAPE
  // of the installed policy and says the behavioural proof belongs elsewhere.
  assert.match(M058, /bypasses row-level security/);
  assert.match(M058, /from pg_policies/);
  assert.ok(
    !/insert into messages/i.test(M058),
    "a migration cannot exercise a policy it is exempt from"
  );
});
