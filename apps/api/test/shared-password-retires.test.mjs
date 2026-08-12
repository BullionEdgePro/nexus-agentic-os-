// The shared operator password, and the condition that closes it.
//
// `demo1234` plus any syntactically valid email has been a full cross-tenant
// login into five businesses' customer conversations since admin accounts were
// added. Not through an oversight in reasoning — the login route has carried a
// comment the whole time saying the shared password "should be removed once a
// real admin account has been created and used". The condition was correct,
// written down, and never enforced.
//
// That is its own lesson, and the reason these assertions are behavioural where
// they can be: a rule that lives only in a comment is a rule that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const LOGIN = read("apps", "web", "app", "api", "auth", "login", "route.ts");
const ADMIN_AUTH = read("apps", "api", "src", "routes", "admin-auth.ts");
const ADMINS_DB = read("packages", "db", "src", "admins.ts");

// ============================================================
// The condition is enforced, not merely described
// ============================================================

test("the shared password is checked against the bootstrap state before it is accepted", () => {
  const branch = LOGIN.slice(
    LOGIN.indexOf("if (secret === operatorPassword()"),
    LOGIN.indexOf("return NextResponse.json({ error: \"That email and password don't match.\" }")
  );
  assert.ok(branch.length > 300, "the branch slice must not be empty");
  // The refusal must come BEFORE the session is issued, not alongside it.
  const guard = branch.indexOf("await sharedPasswordRetired()");
  const grant = branch.indexOf("return issue(identifier");
  assert.ok(guard !== -1, "the bootstrap check must be present");
  assert.ok(guard < grant, "the check must run before the session is issued");
});

test("retirement is keyed on an admin having SIGNED IN, not merely existing", () => {
  // Existence proves a script ran. A login proves the credential works and
  // somebody holds it. Retiring on existence alone would lock the owner out of
  // their own console the first time a create script ran with a password that
  // was then mistyped or lost — a security fix that becomes an outage.
  assert.match(ADMINS_DB, /export async function hasWorkingAdminAccount/);
  assert.match(ADMINS_DB, /where is_active = true and last_login_at is not null/);
});

test("deactivating the only admin reopens the bootstrap window", () => {
  // Otherwise revoking the last working account leaves nobody able to sign in
  // at all, with no way back short of a database edit.
  const query = ADMINS_DB.slice(ADMINS_DB.indexOf("hasWorkingAdminAccount"));
  assert.match(query, /is_active = true/);
});

// ============================================================
// Both failure paths fail CLOSED
// ============================================================

test("an unreachable API refuses the shared password rather than allowing it", () => {
  // The dangerous reading is the opposite one: a failed lookup is not evidence
  // that no admin exists, and treating it as such would let any transient blip
  // re-enable a known password. Being locked out for a minute is recoverable.
  const fn = LOGIN.slice(LOGIN.indexOf("async function sharedPasswordRetired"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /if \(!response\.ok\) return true;/);
  assert.match(body, /catch \{\s*\n\s*return true;/);
  // A malformed payload must also read as retired — only an explicit false opens
  // the window, so a missing field cannot be mistaken for permission.
  assert.match(body, /data\.sharedPasswordRetired !== false/);
});

test("the endpoint itself fails closed when the database is unreachable", () => {
  const handler = ADMIN_AUTH.slice(
    ADMIN_AUTH.indexOf('adminAuthRoute.get("/admin/bootstrap"'),
    ADMIN_AUTH.indexOf('adminAuthRoute.post("/admin"')
  );
  assert.ok(handler.length > 200, "the handler slice must not be empty");
  assert.match(handler, /catch[\s\S]*sharedPasswordRetired: true/);
});

// ============================================================
// While the window is open, it says so
// ============================================================

test("every use of the shared password is logged, not just the first", () => {
  // A warning that fires once at boot is invisible in a log nobody tails, and
  // says nothing about whether anyone is actually still using the door.
  const branch = LOGIN.slice(LOGIN.indexOf("if (secret === operatorPassword()"));
  assert.match(branch, /SHARED OPERATOR PASSWORD USED/);
  assert.match(branch, /grants access to every business/);
  // And it names the fix, because a warning nobody can act on is noise.
  assert.match(branch, /Create an admin account and sign in with it/);
});

test("the refusal tells the operator what to do instead", () => {
  // "Invalid password" for a credential that was valid yesterday, on a console
  // someone owns, reads as a broken system rather than a closed door.
  assert.match(LOGIN, /The shared password has been retired\. Sign in with your admin account\./);
  console.log("PASS: shared password is a bootstrap credential that retires itself");
});
