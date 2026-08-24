/**
 * Every path the web client fetches must be one something actually serves.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * It has already happened, and the record of it is three files away. From
 * activity-broadcasts, on the avatar that shows who is signed in:
 *
 *   "It read a hardcoded 'AA'. The first fix fetched /api/auth/me — an endpoint
 *   that does not exist, which would have failed silently forever and shown a
 *   plausible wrong value."
 *
 * That is the shape. A client fetch to a path nobody serves does not crash: it
 * 404s, the catch swallows it, and the screen shows a default that looks like
 * data. Nothing in the type system connects `request("/api/...")` to
 * `route.get("/...")` — one is a string in the browser bundle and the other is a
 * string in a Hono file, and the only thing holding them together is that
 * somebody typed both.
 *
 * ============================================================
 * WHAT COUNTS AS SERVED
 * ============================================================
 *
 * Two servers answer this app, which is the subtlety that makes a naive version
 * of this test wrong:
 *
 *   the Hono API   mounted in apps/api/src/index.ts, the routes under /api/*
 *   Next itself    apps/web/app/api/**\/route.ts — the login and logout
 *                  handlers live here, in the web app, and are as real as any
 *                  Hono route
 *
 * Both are derived from their own source. A first pass at this reported the two
 * Next handlers as missing endpoints, which would have been a check crying wolf
 * about the thing it was built to protect.
 *
 * Paths are compared with parameters flattened, because the router matches by
 * position: `/api/organizations/:slug/employees` and
 * `/api/organizations/${orgSlug}/employees` are the same endpoint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { walk, withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const INDEX = readFileSync(join(ROOT, "apps", "api", "src", "index.ts"), "utf8");

/** `:anything` and `${anything}` are the same wildcard to a router. */
function flatten(path) {
  return path
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/\?.*$/, "")
    .replace(/:[A-Za-z0-9_]+/g, ":p")
    // A wildcard glued to the end of a segment is a QUERY STRING, not a path
    // parameter: `/leads${q}` is /leads with a query, and treating it as a
    // segment invents an endpoint nobody serves. A real parameter always
    // follows a slash.
    .replace(/([^/]):p$/, "$1")
    .replace(/\/+$/, "");
}

/** Every endpoint the Hono API mounts. */
function honoRoutes() {
  const prefixes = new Map();
  for (const m of INDEX.matchAll(/app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)) {
    prefixes.set(m[2], m[1]);
  }

  const routes = new Set();
  for (const file of walk(join(ROOT, "apps", "api", "src", "routes"), (n) => n.endsWith(".ts"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(\w+)\.(get|post|patch|put|delete)\(\s*"([^"]*)"/g)) {
      const prefix = prefixes.get(m[1]);
      if (prefix === undefined) continue;
      routes.add(flatten(m[3] === "/" ? prefix : `${prefix}${m[3]}`));
    }
  }
  return routes;
}

/** Every endpoint Next serves from the web app itself. */
function nextRoutes() {
  const routes = new Set();
  const base = join(ROOT, "apps", "web", "app");
  for (const file of walk(base, (n) => n === "route.ts" || n === "route.tsx")) {
    const rel = file.slice(base.length + 1).split("\\").join("/").replace(/\/route\.tsx?$/, "");
    routes.add(flatten(`/${rel}`));
  }
  return routes;
}

/** Every path the browser bundle asks for, with comments stripped. */
function clientPaths() {
  const found = new Map();
  const base = join(ROOT, "apps", "web");
  for (const file of walk(base, (n) => n.endsWith(".ts") || n.endsWith(".tsx"))) {
    // COMMENTS STRIPPED FIRST. lib/api.ts explains getSharedBrain with the
    // sentence "`/api/quality` is [operator-only by mount]", and a scan that
    // read prose reported a bare /api/quality nobody calls.
    const src = withoutComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/["`](\/(?:api|auth|links)\/[^"`\n]*)["`]/g)) {
      const path = flatten(m[1]);
      if (path === "" || path.includes("${")) continue;
      if (!found.has(path)) found.set(path, file.slice(ROOT.length + 1).split("\\").join("/"));
    }
  }
  return found;
}

test("every path the client fetches is one the API or Next actually serves", () => {
  const served = new Set([...honoRoutes(), ...nextRoutes()]);
  const asked = clientPaths();

  assert.ok(served.size > 30, `only ${served.size} served routes parsed — the scan is broken`);
  assert.ok(asked.size > 20, `only ${asked.size} client paths parsed — the scan is broken`);

  const missing = [...asked].filter(([path]) => !served.has(path));

  assert.deepEqual(
    missing.map(([path, where]) => `${path}  (${where})`),
    [],
    "the client fetches these and nothing serves them. A 404 here does not crash — it is " +
      "caught, and the screen shows a default that looks like data. /api/auth/me is the " +
      "instance this test exists for."
  );
});

test("the Next handlers are recognised, not merely tolerated", () => {
  // The two that would otherwise be reported as missing. Asserted by name so a
  // future version of this test cannot pass by quietly ignoring everything it
  // does not understand.
  const next = nextRoutes();
  assert.ok(next.has("/api/auth/login"), "the Next login handler was not found");
  assert.ok(next.has("/api/auth/logout"), "the Next logout handler was not found");
});
