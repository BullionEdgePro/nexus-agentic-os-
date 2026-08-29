/**
 * Two lists, in two applications, about the same doors.
 *
 * ============================================================
 * THEY DRIFTED. AGAIN.
 * ============================================================
 *
 * The API decides who may open a screen: `app.use("/api/catalog", operatorOnly)`
 * in index.ts. The web app decides who is OFFERED it: `operatorOnly: true` on a
 * nav entry. Neither knows about the other, and they describe the same fact.
 *
 * `catalog.ts` carries this sentence, written the last time they disagreed:
 *
 *   "two lists in two applications is how the nav rail and the operator-only
 *    guard drifted apart once already"
 *
 * It drifted again. An audit of every screen as both roles found the rail
 * offering staff two doors the API refuses — Catalogue and Links — and it would
 * have gone on finding more, because writing the sentence down was never going
 * to be enough. Nothing compared the lists.
 *
 * This compares them. A screen whose endpoint is behind `operatorOnly` in the
 * API must carry `operatorOnly` in the rail, and the test fails naming both
 * sides when it does not.
 *
 * ============================================================
 * WHY THE RAIL IS THE ONE THAT MUST YIELD
 * ============================================================
 *
 * The API is the enforcement point; the rail is a menu. When they disagree the
 * API wins by construction — the person clicks and gets a 403 either way. So
 * the only question is whether they were invited first, and a menu of closed
 * doors teaches somebody the product is broken rather than that the screen is
 * not theirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const INDEX = read("apps", "api", "src", "index.ts");
const NAV = read("apps", "web", "lib", "nav.tsx");

/** Every API path the server puts behind `operatorOnly`. */
function operatorOnlyPrefixes() {
  const out = new Set();
  for (const m of INDEX.matchAll(/app\.use\(\s*"([^"]+)"\s*,\s*operatorOnly\s*\)/g)) {
    out.add(m[1].replace(/\/\*$/, ""));
  }
  return [...out];
}

/** Every nav entry, with the flag the rail carries for it. */
function navEntries() {
  const entries = [];
  for (const m of NAV.matchAll(/href: "([^"]+)"/g)) {
    const start = m.index;
    const end = NAV.indexOf("\n  },", start);
    const body = NAV.slice(start, end === -1 ? undefined : end);
    entries.push({
      href: m[1],
      operatorOnly: /operatorOnly: true/.test(body),
      staffOnly: /staffOnly: true/.test(body),
    });
  }
  return entries;
}

/**
 * Which endpoint each screen actually calls.
 *
 * Kept beside the nav rather than derived, because a screen can call several
 * and only one of them decides whether the page renders at all. Reused from the
 * scoping gate so there is one such table, not two.
 */
const TAB_API = {
  // ONE HREF, TWO SCREENS. The front page renders the metrics deck for an
  // operator and the staff member's own day for an employee — different
  // components calling different endpoints behind the same address. A single
  // endpoint per href cannot say that, and modelling it as the operator's one
  // made this gate report the front page as a door staff are wrongly offered.
  //
  // It is the only entry like this, and it is spelled out rather than special
  // -cased in the checker, because the next screen that grows a second role
  // should be described here rather than exempted somewhere else.
  "/": { operator: "/api/metrics/overview", staff: "/api/my/day" },
  "/inbox": "/api/organizations",
  "/deck/operators": "/api/operators",
  "/deck/board": "/api/tasks",
  "/deck/tasks": "/api/tasks",
  "/deck/bookings": "/api/bookings",
  "/deck/my-clients": "/api/my/clients",
  "/deck/my-campaigns": "/api/my/campaigns",
  "/deck/customers": "/api/organizations",
  "/deck/team": "/api/organizations",
  "/deck/agent": "/api/organizations",
  "/deck/knowledge": "/api/organizations",
  "/deck/procedures": "/api/organizations",
  "/deck/forecast": "/api/organizations",
  "/deck/catalogue": "/api/catalog",
  "/deck/links": "/api/links",
  "/deck/broadcasts": "/api/broadcasts",
  "/deck/activity": "/api/activity",
  "/deck/quality": "/api/quality",
};

test("the API actually gates something, so this test can fail", () => {
  // A scanner that finds nothing passes everything. These are the paths that
  // existed when it was written; the list only has to be non-trivial.
  const prefixes = operatorOnlyPrefixes();
  assert.ok(prefixes.length >= 5, `only found ${prefixes.length} operatorOnly mounts`);
  assert.ok(prefixes.includes("/api/catalog"));
  assert.ok(prefixes.includes("/api/links"));
});

test("every nav entry is in the endpoint table", () => {
  // A new screen has to be classified here, which is the moment somebody
  // decides who may see it. Forgetting defaults to "everyone" in the product.
  for (const entry of navEntries()) {
    assert.ok(TAB_API[entry.href], `nav entry ${entry.href} has no endpoint mapped`);
  }
});

test("a screen behind operatorOnly in the API is operator-only in the rail", () => {
  // THE DEFECT ITSELF. Found by auditing every screen as both roles: Catalogue
  // and Links were offered to staff and refused by the server.
  const prefixes = operatorOnlyPrefixes();
  const offered = [];

  for (const entry of navEntries()) {
    // The endpoint a STAFF member would hit. Where a screen serves both roles
    // from one address, the operator's endpoint says nothing about whether
    // staff were wrongly invited.
    const mapped = TAB_API[entry.href];
    const endpoint = typeof mapped === "string" ? mapped : mapped.staff;
    const gated = prefixes.some((p) => endpoint === p || endpoint.startsWith(`${p}/`));
    if (gated && !entry.operatorOnly) {
      offered.push(`${entry.href} calls ${endpoint}, which the API gates, but the rail offers it to staff`);
    }
  }

  assert.deepEqual(
    offered,
    [],
    `the rail offers doors the API refuses:\n  ${offered.join("\n  ")}\n\n` +
      `Add operatorOnly: true to those nav entries, or stop gating the endpoint. ` +
      `A menu of closed doors teaches somebody the product is broken rather than ` +
      `that the screen is not theirs.`
  );
});

test("the checker can actually fail", () => {
  // Re-run against a nav with the flags stripped: it must find the screens it
  // is meant to find. A guard that cannot fail is worse than no guard.
  const stripped = NAV.replace(/operatorOnly: true/g, "operatorOnly: false");
  const prefixes = operatorOnlyPrefixes();
  const found = [];
  for (const m of stripped.matchAll(/href: "([^"]+)"/g)) {
    const end = stripped.indexOf("\n  },", m.index);
    const body = stripped.slice(m.index, end === -1 ? undefined : end);
    const mapped = TAB_API[m[1]];
    if (!mapped) continue;
    const endpoint = typeof mapped === "string" ? mapped : mapped.staff;
    const gated = prefixes.some((p) => endpoint === p || endpoint.startsWith(`${p}/`));
    if (gated && !/operatorOnly: true/.test(body)) found.push(m[1]);
  }
  assert.ok(found.length >= 4, `stripping the flags should expose several screens, found ${found.length}`);
});

test("a staff-only screen is never also operator-only", () => {
  // Both flags would hide it from everybody, and the rail would render nothing
  // with no error anywhere.
  for (const entry of navEntries()) {
    assert.ok(
      !(entry.staffOnly && entry.operatorOnly),
      `${entry.href} is flagged for both roles, so nobody sees it`
    );
  }
});
