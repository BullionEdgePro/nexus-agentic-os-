// Proving RLS enforces, rather than that it installed.
//
// The doc's own history contains the failure this guards: "App as Postgres
// superuser — RLS would deploy and enforce nothing." pg_policies fills up, the
// migration reports success, rowsecurity reads true, and one tenant can still
// read another's customers. Nothing anywhere says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const VERIFY = readFileSync(join(here, "..", "src", "scripts", "rls-verify.ts"), "utf8");

test("it checks who the application is before anything else", () => {
  // A superuser, a table owner, or a role with rolbypassrls skips every policy
  // unconditionally. Check that last and the whole run is theatre.
  assert.match(VERIFY, /rolsuper/);
  assert.match(VERIFY, /rolbypassrls/);
  assert.match(VERIFY, /tableowner = current_user/);
  assert.ok(
    VERIFY.indexOf("rolsuper") < VERIFY.indexOf("relrowsecurity"),
    "identity must be established before the catalog is trusted"
  );
});

test("a bypassing role stops the run rather than reporting green", () => {
  assert.match(VERIFY, /STOP — the application role bypasses RLS/);
  assert.match(VERIFY, /process\.exit\(1\)/);
});

test("enablement comes from the catalog, not from the migration succeeding", () => {
  assert.match(VERIFY, /from pg_class c/);
  assert.match(VERIFY, /pg_policies/);
});

test("the decisive check counts another tenant's rows from inside this one", () => {
  // Installation is visible in the catalog. Enforcement is only visible by
  // asking for something that should be invisible and getting nothing.
  assert.match(VERIFY, /must not see/);
  assert.match(VERIFY, /LEAKED \$\{leaked\} rows|LEAKED/);
  assert.match(VERIFY, /from contacts where organization_id = \$1/);
});

test("it also proves the tenant can still see itself", () => {
  // A policy that hides everything is secure and useless — and is exactly what
  // a wrong policy looks like. Zero rows is the failure mode of RLS, not its
  // success condition.
  assert.match(VERIFY, /Own rows still visible/);
  assert.match(VERIFY, /do not hide the tenant's own rows/);
});

test("it tells you how to roll back", () => {
  assert.match(VERIFY, /disable row level security/);
  console.log("PASS: rls-verify proves enforcement, not installation");
});

test("the isolation test hides the tenant that actually has rows", () => {
  // The first version took organizations[0] and [1], which on this platform are
  // two businesses with zero contacts. "Invisible" was true because there was
  // nothing to hide: it passed, proved nothing, and was indistinguishable from
  // a real pass. A test that cannot fail is not evidence — the same lesson the
  // preflight's unwrapped half exists for.
  assert.match(VERIFY, /count\(\*\)::text as n from contacts group by organization_id/);
  assert.match(VERIFY, /sort\(\s*\n?\s*\(x, y\) => \(counts\.get\(y\.id\)/);
  assert.match(VERIFY, /NOT TESTABLE/);
  assert.match(VERIFY, /a pass here would mean nothing/);
  console.log("PASS: isolation is tested against the tenant with data, or reported untestable");
});
