/**
 * The mirror of every-button-reaches-a-route: a capability with no screen.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Asked twice to "finish all the features and leave them empty", and answering
 * from the screens was not good enough — a page can exist, carry a tidy empty
 * state, and still be missing the one view that makes the feature usable.
 *
 * The other direction found the real gaps. Two endpoints were fully built,
 * tenant-scoped and tested, and nothing in the console had ever called them:
 *
 *   GET /api/automations/runs        what the rules have actually done
 *   GET /api/quality/:slug/capabilities  what the copilot can answer
 *
 * Both are the same defect in different clothes. A rule that has been firing
 * and one refused on every single finding look identical in the rules list —
 * both active, neither showing a result. And a free-text question box that
 * declines anything it cannot answer from real data reads as broken until you
 * know what to ask.
 *
 * ============================================================
 * WHAT COUNTS AS REACHABLE
 * ============================================================
 *
 * Not every route belongs in `lib/api.ts`. Sign-in posts from the auth pages,
 * the public links page is server-rendered, and the CSV exports are fetched by
 * a download helper on the customers page. Those are listed here by name, with
 * where they are reached from, so the allow-list is a statement about the
 * product rather than a place to bury a genuine omission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const CLIENT = read("apps", "web", "lib", "api.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const CUSTOMERS = read("apps", "web", "app", "deck", "customers", "page.tsx");

/**
 * Reached from somewhere other than the API client, and where.
 *
 * Each entry is a claim that can be checked, and the assertions below check it
 * rather than taking the list on trust.
 */
const REACHED_ELSEWHERE = {
  "POST /auth/employee": "the employee sign-in page posts it directly",
  "POST /auth/admin": "the operator sign-in page posts it directly",
  "GET /auth/admin/bootstrap": "asked once at first-run, before any session exists",
  "GET /links": "the public links page is server-rendered",
  "GET /api/connections/tiktok/callback":
    "TikTok redirects the browser here after consent — it is reached by the platform, not by our client",
  "GET /api/organizations/:slug/export/customers.csv": "download helper on the customers page",
  "GET /api/organizations/:slug/export/messages.csv": "download helper on the customers page",
  "GET /api/organizations/:slug/contacts/:contactId/export.json": "download helper on the customers page",
};

function handlers() {
  const importedFrom = {};
  let m;
  const ire = /import\s+\{?\s*([\w\s,]+?)\s*\}?\s+from\s+"\.\/routes\/([\w-]+)(?:\.js)?"/g;
  while ((m = ire.exec(INDEX))) {
    for (const n of m[1].split(",").map((s) => s.trim()).filter(Boolean)) importedFrom[n] = m[2];
  }
  const out = [];
  const mre = /app\.route\(\s*"([^"]+)"\s*,\s*(\w+)/g;
  while ((m = mre.exec(INDEX))) {
    const [, base, v] = m;
    const file = importedFrom[v];
    if (!file) continue;
    let src;
    try {
      src = read("apps", "api", "src", "routes", `${file}.ts`);
    } catch {
      continue;
    }
    const hre = new RegExp(`${v}\\.(get|post|put|patch|delete)\\(\\s*"([^"]*)"`, "g");
    let h;
    while ((h = hre.exec(src))) {
      out.push({ method: h[1].toUpperCase(), path: (base + h[2]).replace(/\/$/, "") || "/" });
    }
  }
  return out;
}

/**
 * Every path the client names, in BOTH readings of an interpolation.
 *
 * `/api/automations/runs${query}` is a path with an optional query string glued
 * on, not one with a segment in the middle. Substituting a placeholder gave
 * `/api/automations/runsX`, which matched nothing — and the audit reported a
 * live screen as an unreachable endpoint. Keeping both readings is the fix, and
 * the reason this parser is checked by its own test below.
 */
function clientPaths() {
  // Interpolations removed by SCANNING, not by a regex.
  //
  // `/api/activity${orgSlug ? `?business=${orgSlug}` : ""}` nests a template
  // literal inside its own interpolation. A `[^`]*` capture stops at the inner
  // backtick and a `\$\{[^}]*\}` substitution then finds no complete
  // interpolation to remove, so the path never normalised and a live screen was
  // reported as an unreachable endpoint — the third time this audit invented a
  // gap. Counting braces handles nesting; a regex cannot.
  const stripped = (src, filler) => {
    let out = "";
    for (let i = 0; i < src.length; i += 1) {
      if (src[i] === "$" && src[i + 1] === "{") {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "{") depth += 1;
          else if (src[i] === "}") depth -= 1;
          i += 1;
        }
        i -= 1;
        out += filler;
      } else {
        out += src[i];
      }
    }
    return out;
  };

  const literals = [
    ...[...CLIENT.matchAll(/`([^`]*)`/g)].map((x) => x[1]),
    ...[...CLIENT.matchAll(/"(\/(?:api|auth|links)[^"]*)"/g)].map((x) => x[1]),
    ...[...CUSTOMERS.matchAll(/`([^`]*)`/g)].map((x) => x[1]),
    // The nested case, read from the whole source rather than from a literal:
    // whatever a path starts with is enough to identify the route it hits.
    ...[...CLIENT.matchAll(/`(\/(?:api|auth|links)[^`$]*)/g)].map((x) => x[1]),
  ].filter((p) => p.startsWith("/api") || p.startsWith("/auth") || p.startsWith("/links"));

  // Both readings: a hole mid-path is a segment, a hole at the end is a query.
  return literals
    .flatMap((p) => [stripped(p, "X"), stripped(p, "")])
    .map((p) => p.split("?")[0].replace(/\/$/, ""));
}

const HANDLERS = handlers();
const PATHS = clientPaths();

const reachable = (h) => {
  const body = h.path
    .split("/")
    .map((s) => (s.startsWith(":") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c)))
    .join("/");
  const re = new RegExp(`^${body}$`);
  return PATHS.some((p) => re.test(p));
};

test("the parser still recognises both sides", () => {
  // The same floor as its mirror test, and for the same reason: two regexes
  // away from passing vacuously forever. This audit has already been wrong
  // twice -- once reading only template literals, once mangling a query suffix
  // -- and both times it INVENTED gaps rather than hiding them, which is the
  // lucky direction. Hiding one is the direction this floor guards.
  assert.ok(HANDLERS.length >= 60, `only ${HANDLERS.length} handlers found`);
  assert.ok(new Set(PATHS).size >= 50, `only ${new Set(PATHS).size} client paths found`);
});

test("every server capability has somewhere in the product that uses it", () => {
  const unreachable = HANDLERS.filter((h) => !reachable(h))
    .map((h) => `${h.method} ${h.path}`)
    .filter((key) => !(key in REACHED_ELSEWHERE));

  assert.deepEqual(
    unreachable,
    [],
    `built and unreachable — either give it a screen or say where it is reached from:\n  ${unreachable.join("\n  ")}`
  );
});

test("the allow-list names real routes, so it cannot rot into an excuse", () => {
  // An entry for a route that no longer exists is how an allow-list quietly
  // becomes a place to put things. Every exemption must still be a real
  // handler, or it has to go.
  for (const key of Object.keys(REACHED_ELSEWHERE)) {
    const [method, path] = key.split(" ");
    assert.ok(
      HANDLERS.some((h) => h.method === method && h.path === path),
      `the allow-list exempts ${key}, which is not a route any more`
    );
  }
});

test("a rule's history is on the screen that shows the rule", () => {
  // The gap this test was written after. Without it, "assign every urgent
  // finding to Sara" is a promise nobody can check.
  const AUTOMATIONS = read("apps", "web", "app", "deck", "board", "automations.tsx");
  assert.match(AUTOMATIONS, /getAutomationRuns\(/);
  assert.match(
    AUTOMATIONS,
    /run\.failedReason/,
    "a rule that fired and was refused is the case worth showing"
  );
  assert.match(
    AUTOMATIONS,
    /runsReadable === false/,
    "an unreadable history must not render as 'nothing has run'"
  );
});

test("the question box says what it can answer", () => {
  const QUALITY = read("apps", "web", "app", "deck", "quality", "page.tsx");
  assert.match(QUALITY, /getCopilotCapabilities\(/);
  assert.match(
    QUALITY,
    /setQuestion\(what\)/,
    "the shortest path from 'what can I ask' to an answer is not retyping the sentence"
  );
});
