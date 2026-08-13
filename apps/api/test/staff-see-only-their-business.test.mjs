// A staff member must only reach the business they are assigned to — and must
// only be OFFERED what they can actually reach.
//
// Two separate promises, enforced in two different places:
//
//   1. The data boundary. `requireTenantScope` compares the :slug in the path
//      against the organizationSlug signed into the session. That is the real
//      security boundary and it fails closed.
//
//   2. The navigation. Five surfaces are operator-only server side. If the rail
//      offers one of them to an employee, they click it and get an error state.
//      Nothing is leaked — the API refuses correctly — but the product reads as
//      broken, which is its own kind of failure and the one a person actually
//      experiences.
//
// The second promise is kept by two lists in two different applications that
// nothing connected: `operatorOnly` middleware in apps/api/src/index.ts, and
// the `operatorOnly` flag in apps/web/lib/nav.tsx. They had already drifted —
// the API guarded five surfaces, the rail hid three — so an employee saw
// "Customer links", opened it, and watched it fail. This test is the thing that
// connects them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const INDEX = read("apps", "api", "src", "index.ts");
const NAV = read("apps", "web", "lib", "nav.tsx");
const WEB_API = read("apps", "web", "lib", "api.ts");
const TENANT_SCOPE = read("apps", "api", "src", "middleware", "require-tenant-scope.ts");

// ============================================================
// Which tab calls which endpoint
// ============================================================

// Declared rather than derived: a tab's data source is a fact about the product
// that a regex over JSX would only ever guess at. Each entry is checked against
// apps/web/lib/api.ts below, so this table cannot quietly become fiction.
const TAB_API = {
  "/": "/api/metrics/overview",
  "/inbox": "/api/organizations/",
  "/deck/operators": "/api/operators",
  "/deck/tasks": "/api/tasks",
  "/deck/team": "/api/organizations/",
  "/deck/knowledge": "/api/organizations/",
  "/deck/links": "/api/links",
  "/deck/broadcasts": "/api/broadcasts",
  "/deck/activity": "/api/activity",
  "/deck/quality": "/api/quality",
};

// Routes that serve DIFFERENT CONTENT by role rather than refusing one.
//
// "/" is the only one. An operator gets the cross-tenant metrics overview; an
// employee gets their own workspace, locked to their business, from the same
// href. So the rail is right to show it to both, even though the operator's
// data source is operator-only. This has to be declared explicitly, because
// "the endpoint is operator-only but the tab is visible" is otherwise
// indistinguishable from the bug this file exists to catch.
const ROLE_BRANCHED = new Set(["/"]);

// ============================================================
// Reading the two lists
// ============================================================

function apiOperatorOnlyPrefixes() {
  // app.use("/api/quality/*", operatorOnly)  ->  /api/quality
  const found = [...INDEX.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*operatorOnly\s*\)/g)];
  assert.ok(found.length >= 5, `expected the operatorOnly registrations, found ${found.length}`);
  return found.map((m) => m[1].replace(/\/\*$/, ""));
}

function navEntries() {
  // Each entry is `href: "...", label: "...", icon: (...), operatorOnly?: true`.
  // Split on href so a flag is read against the entry it belongs to, not the
  // next one along.
  const chunks = NAV.split(/href:\s*"/).slice(1);
  return chunks.map((chunk) => {
    const href = chunk.slice(0, chunk.indexOf('"'));
    const label = (chunk.match(/label:\s*"([^"]+)"/) ?? [, "?"])[1];
    return { href, label, operatorOnly: /operatorOnly:\s*true/.test(chunk) };
  });
}

const OPERATOR_ONLY = apiOperatorOnlyPrefixes();
const ENTRIES = navEntries();

const isOperatorOnly = (path) => OPERATOR_ONLY.some((prefix) => path.startsWith(prefix));

// ============================================================
// The tables must describe the real product
// ============================================================

test("every navigation entry is classified", () => {
  // A new tab must be given a data source here, which is the moment somebody
  // has to decide whether an employee may see it. Forgetting defaults to
  // "visible to everyone" in the product and silence in the tests, so the
  // omission has to fail.
  for (const entry of ENTRIES) {
    assert.ok(TAB_API[entry.href], `nav entry "${entry.label}" (${entry.href}) has no TAB_API mapping`);
  }
  assert.equal(ENTRIES.length, Object.keys(TAB_API).length, "TAB_API has entries the rail does not");
});

test("every declared endpoint is one the web client really calls", () => {
  // Keeps TAB_API honest. A renamed route would otherwise leave this file
  // asserting a relationship between two things that no longer exist, and
  // passing.
  for (const [href, path] of Object.entries(TAB_API)) {
    assert.ok(WEB_API.includes(path), `TAB_API says ${href} calls ${path}, absent from lib/api.ts`);
  }
});

// ============================================================
// The rail must not offer what the API will refuse
// ============================================================

test("no employee is offered a tab the API will refuse", () => {
  const offered = ENTRIES.filter((entry) => !entry.operatorOnly && !ROLE_BRANCHED.has(entry.href))
    .filter((entry) => isOperatorOnly(TAB_API[entry.href]));

  assert.deepEqual(
    offered.map((entry) => entry.label),
    [],
    "these tabs are visible to employees but operator-only server side — they open to an error"
  );
});

test("no tab is hidden from employees that they could actually use", () => {
  // The opposite drift, and quieter: nobody reports a tab they were never
  // shown. Follow-ups is the case that matters — it is the working surface of
  // the person doing the work, deliberately reachable by employees and narrowed
  // to their business inside the route.
  const hidden = ENTRIES.filter((entry) => entry.operatorOnly)
    .filter((entry) => !isOperatorOnly(TAB_API[entry.href]));

  assert.deepEqual(
    hidden.map((entry) => entry.label),
    [],
    "these tabs are hidden from employees but the API would have served them"
  );
});

test("the counts match, so neither list can drift alone", () => {
  const railHides = ENTRIES.filter((entry) => entry.operatorOnly).length;
  const apiRefuses = ENTRIES.filter(
    (entry) => isOperatorOnly(TAB_API[entry.href]) && !ROLE_BRANCHED.has(entry.href)
  ).length;
  assert.equal(railHides, apiRefuses, `rail hides ${railHides}, API refuses ${apiRefuses}`);
});

// ============================================================
// The boundary underneath it all
// ============================================================

test("the rail is filtered by role at render time", () => {
  const SHELL = read("apps", "web", "app", "console-shell.tsx");
  // The flag existed on three entries and was read by nothing at all for a
  // while. A flag nobody reads is worse than no flag, because it reads like a
  // control.
  assert.match(SHELL, /role === "operator" \? NAV : NAV\.filter\(\(item\) => !item\.operatorOnly\)/);
});

test("scope comes from the signed session, never from the request", () => {
  // The URL says which business; the cookie says which business you may have.
  // Comparing them is the entire boundary. Reading the org from a header, a
  // query parameter or a body field would let the caller pick their own answer.
  assert.match(TENANT_SCOPE, /slug !== scope\.organizationSlug/);
  assert.match(TENANT_SCOPE, /return deny\(/);
  // An unknown caller must degrade to "employee of no business", not operator.
  assert.match(TENANT_SCOPE, /\?\?\s*\{\s*sub:\s*"unknown",\s*role:\s*"employee"\s*\}/);
});

test("a tenant route with no slug is refused rather than allowed through", () => {
  // The dangerous default. `requireTenantScope` is mounted on a :slug pattern,
  // so a route landing there without one means the wiring changed underneath
  // it — and an employee reaching an unscoped tenant route is the failure this
  // whole file is about.
  assert.match(TENANT_SCOPE, /if \(!slug\) return deny\(/);
  console.log(`PASS: ${ENTRIES.length} tabs classified, ${OPERATOR_ONLY.length} operator-only API surfaces`);
});
