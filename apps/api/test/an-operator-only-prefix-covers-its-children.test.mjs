/**
 * A prefix that is operator-only must be operator-only all the way down.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * index.ts states the design out loud: the authorisation checks are "applied at
 * the mount rather than inside handlers so a new endpoint under one of these
 * prefixes is scoped by default". That is the right design and it is why nobody
 * has to remember anything when adding a route.
 *
 * It was not true of one prefix. Measured against this Hono version on
 * 2026-08-24 by mounting middleware both ways and asking for four paths:
 *
 *   app.use("/api/links", mw)       /api/links            -> mw ran
 *                                   /api/links/xyz        -> NO MIDDLEWARE AT ALL
 *   app.use("/api/metrics/*", mw)   /api/metrics          -> mw ran
 *                                   /api/metrics/overview -> mw ran
 *
 * So a wildcard mount covers the bare path and its children, and a bare mount
 * covers only itself. `/api/links` was mounted bare and alone. Nothing was
 * exposed — linksRoute defines only "/" — but the guarantee the comment makes
 * was false there, and the failure would have arrived as somebody adding
 * `linksRoute.get("/:id")` and publishing the deep-link registry to every
 * authenticated employee, on a platform whose employees work for five different
 * companies.
 *
 * `requireAuth` is not the gap. It is mounted at "/api/*", a wildcard, so every
 * path under /api is authenticated. What a bare mount loses is AUTHORISATION —
 * who, not whether.
 *
 * ============================================================
 * WHAT IT ENFORCES
 * ============================================================
 *
 * Every path handed to operatorOnly must appear in wildcard form. The bare form
 * may also be there and does no harm; it is the wildcard that carries the
 * promise. Written as a property of the mount list rather than a list of known
 * routes, so it holds for endpoints nobody has written yet — which is the whole
 * point of mounting the check instead of calling it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

/** Every path mounted with a given middleware, in source order. */
function mountsOf(middleware) {
  const paths = [];
  const re = new RegExp(`app\\.use\\(\\s*"([^"]+)"\\s*,\\s*${middleware}\\s*\\)`, "g");
  for (const m of INDEX.matchAll(re)) paths.push(m[1]);
  return paths;
}

test("every operator-only prefix is mounted with a wildcard", () => {
  const mounts = mountsOf("operatorOnly");

  // The loop below is the whole test, so a mount list that failed to parse
  // would leave it green having checked nothing. This suite has already shipped
  // one test that did exactly that.
  assert.ok(mounts.length >= 5, `only ${mounts.length} operatorOnly mounts found — did the parse break?`);

  const wildcards = new Set(mounts.filter((p) => p.endsWith("/*")).map((p) => p.slice(0, -2)));
  const uncovered = mounts.filter((p) => !p.endsWith("/*") && !wildcards.has(p));

  assert.deepEqual(
    uncovered,
    [],
    "these are operator-only for themselves and open to any authenticated employee " +
      `beneath: ${uncovered.join(", ")}. Add app.use("<path>/*", operatorOnly).`
  );
});

test("requireAuth covers everything under /api", () => {
  // The authentication half, asserted separately because it fails differently:
  // a gap here is anonymous access rather than an employee reading an owner's
  // screen, and it is covered by a wildcard today.
  assert.ok(
    /app\.use\("\/api\/\*",\s*requireAuth\)/.test(INDEX),
    "requireAuth must be mounted at /api/* — a bare /api mount would leave every child open"
  );
});

test("the tenant and conversation scopes are mounted on children, not on the bare path", () => {
  // These two are the opposite case and worth pinning: they exist to constrain
  // what lies BENEATH a parameterised path, so a bare mount would be the bug
  // rather than the omission.
  assert.ok(/app\.use\("\/api\/organizations\/:slug\/\*",\s*requireTenantScope\)/.test(INDEX));
  assert.ok(/app\.use\("\/api\/conversations\/:id\/\*",\s*requireConversationScope\)/.test(INDEX));
});
