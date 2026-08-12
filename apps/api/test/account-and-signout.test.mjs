// Two faults reported from one screenshot: "why can I not edit my profile" and
// "the sign out button is not working". Both were real, and both were silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const LOGOUT = read("apps", "web", "app", "api", "auth", "logout", "route.ts");
const LOGIN = read("apps", "web", "app", "api", "auth", "login", "route.ts");
const ME = read("apps", "api", "src", "routes", "me.ts");
const SESSION = read("apps", "api", "src", "lib", "session.ts");
const MENUS = read("apps", "web", "app", "header-menus.tsx");

// ============================================================
// Sign out has to clear the cookie that actually exists
// ============================================================

test("logout clears the cookie on the same domain it was set on", () => {
  // A cookie is identified by name, DOMAIN and path, and can only be expired by
  // a Set-Cookie carrying the same three. The session is issued WITH a Domain,
  // because the app and API sit on sibling subdomains and a host-only cookie
  // would never reach the second. Logout cleared it WITHOUT one — which sets a
  // different, host-only cookie and expires that. The real session survived,
  // the refresh rendered the console again, and Sign out looked inert.
  assert.match(LOGIN, /domain: sessionCookieDomain\(\)/);
  assert.match(LOGOUT, /domain,/);
  assert.match(LOGOUT, /const domain = sessionCookieDomain\(\)/);
  // Every other attribute mirrors the write too.
  for (const attr of [/httpOnly: true/, /sameSite: "lax"/, /path: "\/"/, /maxAge: 0/]) {
    assert.match(LOGOUT, attr);
  }
});

test("sessions written before the domain was configured are cleared too", () => {
  // Those are genuinely host-only, and the delete above — now carrying a Domain
  // — would not match them. Two headers, and nobody is left signed in by a
  // cookie written under the old configuration.
  assert.match(LOGOUT, /if \(domain\) \{[\s\S]*?maxAge: 0,[\s\S]*?\}/);
});

// ============================================================
// An operator does have a profile
// ============================================================

test("the API knows which admin an operator session belongs to", () => {
  // The web app has signed adminId into the token since admin accounts landed;
  // this decoder dropped it, so every operator looked anonymous to the API and
  // /api/me could not tell whose row to read.
  assert.match(SESSION, /adminId\?: string;/);
  assert.match(SESSION, /role: "operator", adminId: payload\.adminId/);
});

test("the operator branch reads the real admin row", () => {
  // It returned fullName: null and editable: false. `admins` has carried
  // full_name since accounts existed — which is why the panel showed the same
  // email twice, as the name and as the address.
  const branch = ME.slice(ME.indexOf('if (scope.role === "operator")'), ME.indexOf("const employee ="));
  assert.ok(branch.length > 300, "the operator branch slice must not be empty");
  assert.match(branch, /findAdminById\(scope\.adminId\)/);
  assert.match(branch, /fullName: admin\?\.fullName/);
  assert.match(branch, /editable: Boolean\(admin\)/);
  // Checked against code: the comment above the fix names the old value on
  // purpose, and a raw scan flags the explanation rather than a regression.
  const code = branch.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(!/editable: false/.test(code), "operators are no longer refused outright");
});

test("an operator can save, and is not offered a field they cannot use", () => {
  // WhatsApp is employee-only: an operator takes no handoffs, so the box would
  // change nothing. Omitted from the request rather than sent as null, which
  // would read as "clear it".
  assert.match(ME, /if \(scope\.role === "operator"\)[\s\S]{0,600}updateAdminProfile\(adminId/);
  assert.match(MENUS, /me\?\.role === "employee" \? \{ whatsappNumber:/);
  assert.ok(
    !/Operator accounts have no profile to edit/.test(MENUS),
    "the refusal message must not return"
  );
});

test("a session with no admin behind it is told what to do", () => {
  // One minted by the retired shared password. There is no row to edit, and
  // writing to whichever admin shares the address would be worse than refusing.
  assert.match(ME, /This session predates named admin accounts\. Sign out and back in\./);
  console.log("PASS: sign out clears the real cookie, and an operator has a profile");
});
