/**
 * Watching the console the way one business's staff watch it.
 *
 * ============================================================
 * WHY THIS COULD NOT BE A CLIENT-SIDE FILTER
 * ============================================================
 *
 * The obvious build narrows the CONSOLE and leaves the API alone: hide the tabs
 * the staff cannot see, keep fetching everything. That version LIES. It answers
 * "what do my staff see?" with a picture assembled from data those staff cannot
 * obtain, so every question the owner actually has — is anything leaking, does
 * their queue look empty, would they notice this customer — gets answered by the
 * wrong system. The one bug it can never show is the one worth looking for.
 *
 * So the downgrade happens at the single place a scope is decided, and every
 * route below behaves exactly as it would for a real employee without any of
 * them knowing this feature exists. These tests pin the properties that make
 * that safe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const AUTH = read("apps", "api", "src", "middleware", "require-auth.ts");
const API = read("apps", "web", "lib", "api.ts");
const VIEW = read("apps", "web", "app", "view-as-staff.tsx");
const SHELL = read("apps", "web", "app", "console-shell.tsx");

const PREVIEW = AUTH.slice(
  AUTH.indexOf("async function previewScope"),
  AUTH.indexOf("export const requireAuth")
);

// ============================================================
// 1. It can only ever narrow
// ============================================================

test("the preview downgrades to employee and never to anything wider", () => {
  // The header names a business. If it could produce any role but employee, a
  // header would be a privilege escalation instead of a demotion.
  assert.match(PREVIEW, /role: "employee"/);
  assert.ok(
    !/role: "operator"/.test(PREVIEW),
    "the preview can now hand out the operator role, which is the opposite of its purpose"
  );
});

test("only an operator can preview, so the header is inert for everybody else", () => {
  // An employee sending this header must be unaffected — otherwise staff could
  // step sideways into another business by typing its slug.
  assert.match(
    PREVIEW,
    /session\.role !== "operator"/,
    "any signed-in user can now assume another business by sending a header"
  );
});

test("a script's bearer token is never downgraded", () => {
  // The preview is a thing a person does in a browser. A worker or a cron job
  // narrowing itself silently would look exactly like a job that ran and found
  // nothing to do.
  const bearerBranch = AUTH.indexOf('sub: "api-token"');
  const cookieBranch = AUTH.indexOf("previewScope(c, session)");
  assert.ok(bearerBranch !== -1, "the bearer branch is gone");
  assert.ok(
    cookieBranch > bearerBranch,
    "previewScope moved into or above the bearer branch, so scripts can be narrowed too"
  );
});

// ============================================================
// 2. An unknown business is refused, not ignored
// ============================================================

test("an unrecognised slug fails the request rather than falling through", () => {
  // Falling through is the dangerous default: the console would show a
  // STAFF-VIEW BANNER over OPERATOR DATA — every business at once, labelled as
  // one. Refusing is loud and correct.
  assert.match(PREVIEW, /if \(!organization\)/);
  assert.match(PREVIEW, /return \{ error:/);
  assert.match(AUTH, /return c\.json\(\{ error: viewing\.error \}, 400\)/);
});

// ============================================================
// 3. The client sends it on everything, including writes
// ============================================================

test("the header rides on every request, not just the reads", () => {
  // A preview where reads are narrowed and writes are not is worse than none:
  // the owner would be testing whether staff can SEE something while keeping
  // the power to CHANGE it, and would draw a conclusion about permissions from
  // a session that had two of them.
  const request = API.slice(API.indexOf("async function request"));
  assert.match(request, /x-nexus-view-as/);
});

test("the preview is session-scoped, so closing the tab ends it", () => {
  // localStorage would make this a SETTING — an owner would return days later
  // to a console quietly showing one fifth of their platform, with the banner
  // scrolled off the top. It is a thing you are doing now.
  assert.match(API, /sessionStorage/);
  assert.ok(
    !/localStorage[^\n]*viewAs/.test(API),
    "the preview outlives the tab again"
  );
});

// ============================================================
// 4. It is impossible to forget you are in one
// ============================================================

test("the banner names the business and offers the way out", () => {
  assert.match(VIEW, /Viewing as staff at/);
  assert.match(VIEW, /Back to my own view/);
});

test("the banner says the thing no screen can say for itself", () => {
  // The preview has no employee identity — the owner is not one of their own
  // staff — so every "assigned to me" list is empty. An empty follow-up queue
  // reads as a fact about the business unless something says otherwise.
  assert.match(VIEW, /because you are not one of them/);
});

test("the banner is on every page, and only for operators", () => {
  assert.match(SHELL, /role === "operator" \? <ViewAsStaff \/> : null/);
});
