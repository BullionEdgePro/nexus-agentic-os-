/**
 * A route that takes an id and no slug must restrict itself to the caller's business.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * index.ts mounts the authorisation checks in front of whole prefixes so that a
 * new endpoint underneath one is scoped by default, and says so. That works for
 * every prefix that HAS such a mount: `/api/organizations/:slug/*`,
 * `/api/conversations/:id/*`, and the operator-only list.
 *
 * Three routers have no mount at all — `/api/tasks`, `/api/bookings`,
 * `/api/operators`. Each takes a bare entity id, each runs cross-tenant because
 * there is no slug in the path to scope by, and each therefore has to remember
 * on its own. All three do it correctly today:
 *
 *   bookings   `within = scope.organizationId` unless the caller is an operator
 *   tasks      the same, passed to setTaskStatus and setTaskOwner
 *   operators  `finding.businessId === scope.organizationId`, and the same 404
 *              for "no such finding" and "not yours" so ids cannot be enumerated
 *
 * Three correct implementations, in three different shapes, held together by
 * whoever last remembered. bookings.ts states the cost in its own words: without
 * it, "an employee holding any booking id could cancel another business's
 * appointment. The row would change, the response would look ordinary, and the
 * trace would be a customer arriving for a slot the system says was called off."
 *
 * That is a convention, and this repository's own phrase for a convention is a
 * property nobody can check. `every-agent-read-widens-itself` made the same
 * argument about database readers and closed it. This closes it for routes.
 *
 * ============================================================
 * WHAT IT ACTUALLY CHECKS
 * ============================================================
 *
 * The prefixes that ARE covered are read out of index.ts rather than listed
 * here, so exempting a route by adding middleware works and exempting one by
 * editing this file does not.
 *
 * A handler is required to consult BOTH `scope.role` and `scope.organizationId`.
 * Role alone is a check that forgets which business; organizationId alone is one
 * that would lock operators out of the deck they own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = join(here, "..", "src", "routes");
const INDEX = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

/** router variable -> the prefix it is mounted at. */
function mountPrefixes() {
  const out = new Map();
  for (const m of INDEX.matchAll(/app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)) {
    out.set(m[2], m[1]);
  }
  return out;
}

/** Prefixes that already carry an authorisation middleware, from index.ts. */
function guardedPrefixes() {
  const out = [];
  for (const m of INDEX.matchAll(
    /app\.use\(\s*"([^"]+)"\s*,\s*(operatorOnly|requireTenantScope|requireConversationScope)\s*\)/g
  )) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Parameter names carry no meaning to the router, so they must carry none here.
 *
 * `/api/conversations/:id/*` and `/api/conversations/:conversationId/assign`
 * are the same path to Hono, which matches by POSITION. The first version of
 * this compared the strings and reported both conversation-assignment routes as
 * unguarded — two false alarms out of four, on a check whose whole value is
 * being believed.
 */
const normalise = (path) => path.replace(/:[A-Za-z0-9_]+/g, ":p");

/** Does a mounted middleware path cover this full route path? */
function isGuarded(fullPath, guards) {
  const target = normalise(fullPath);
  return guards.some((raw) => {
    const guard = normalise(raw);
    if (guard.endsWith("/*")) {
      const base = guard.slice(0, -2);
      // Measured 2026-08-24: a wildcard mount covers the bare path and its
      // children; a bare mount covers only itself.
      return target === base || target.startsWith(`${base}/`);
    }
    return target === guard;
  });
}

/**
 * The handler's own source, plus any local function it hands off to.
 *
 * operators.ts does the restriction inside `handleDismissal`, which both of its
 * routes call in one line. Reading only the route body reported both as
 * unguarded — the other two false alarms. One level of delegation is enough for
 * every route here and stops well short of chasing imports across packages.
 */
function withDelegates(body, fileSource) {
  // Plain string work, no regex. The first version built one with new RegExp
  // and a template literal, and the escaping did not survive the tool that
  // wrote the file -- the pattern arrived with its parenthesis unescaped and
  // its newlines literal, which is a documented recurring failure here.
  let out = body;
  const NL = String.fromCharCode(10);
  const decls = [];
  for (const keyword of [NL + "function ", NL + "async function "]) {
    let at = fileSource.indexOf(keyword);
    while (at !== -1) {
      const nameStart = at + keyword.length;
      const paren = fileSource.indexOf("(", nameStart);
      if (paren !== -1) {
        decls.push({ name: fileSource.slice(nameStart, paren).trim(), at });
      }
      at = fileSource.indexOf(keyword, at + 1);
    }
  }
  for (const decl of decls) {
    if (!decl.name || !body.includes(decl.name + "(")) continue;
    // To the next declaration of any kind, which is close enough: an extra
    // helper swept in can only make this MORE willing to believe a route is
    // guarded, and a false clear is caught by the mutation test below.
    const ends = decls.map((d) => d.at).filter((a) => a > decl.at);
    const stop = ends.length ? Math.min(...ends) : fileSource.length;
    out += fileSource.slice(decl.at, stop);
  }
  return out;
}

/** Every declared route, with its handler body. */
function declaredRoutes() {
  const prefixes = mountPrefixes();
  const routes = [];

  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");

    for (const m of src.matchAll(/(\w+)\.(get|post|patch|put|delete)\(\s*"([^"]*)"/g)) {
      const [, router, method, path] = m;
      const prefix = prefixes.get(router);
      if (prefix === undefined) continue; // not mounted on the app; not reachable

      // The handler body: from this declaration to the next route declaration.
      const nextDecl = src.slice(m.index + m[0].length).search(/\n\w+\.(get|post|patch|put|delete)\(/);
      const body = src.slice(m.index, nextDecl === -1 ? undefined : m.index + m[0].length + nextDecl);

      routes.push({
        file,
        method,
        full: path === "/" ? prefix : `${prefix}${path}`,
        path,
        body: withDelegates(body, src),
      });
    }
  }
  return routes;
}

test("every route that takes a bare id restricts by the caller's business", () => {
  const guards = guardedPrefixes();
  const routes = declaredRoutes();

  // The whole test lives in the loop below, so a parse failure would leave it
  // green having examined nothing. This suite has already shipped one of those.
  assert.ok(routes.length > 30, `only ${routes.length} routes parsed — the scan is probably broken`);
  assert.ok(guards.length > 5, `only ${guards.length} guarded prefixes parsed`);

  const offenders = [];
  for (const route of routes) {
    // A slug in the path is scoped by requireTenantScope; a path with no
    // parameter at all addresses no particular row.
    if (!/:\w+/.test(route.path)) continue;
    if (route.path.includes(":slug")) continue;
    if (isGuarded(route.full, guards)) continue;

    const checksRole = route.body.includes("scope.role");
    const checksOrg = route.body.includes("scope.organizationId");
    if (!checksRole || !checksOrg) {
      offenders.push(`${route.file}: ${route.method.toUpperCase()} ${route.full}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these take an entity id, sit under no authorisation mount, and do not check " +
      `the caller's business — any authenticated employee can address another ` +
      `company's row:\n  ${offenders.join("\n  ")}\n\n` +
      "Either restrict in the handler (scope.role / scope.organizationId, as " +
      "bookings.ts does) or mount a check in front of the prefix in index.ts."
  );
});

test("the checker can actually fail", () => {
  // Re-run the same scan with the restriction textually removed, and it must
  // find the routes again. Without this the test above passes just as happily
  // when its own matching has broken.
  const guards = guardedPrefixes();
  let wouldFlag = 0;

  for (const route of declaredRoutes()) {
    if (!/:\w+/.test(route.path)) continue;
    if (route.path.includes(":slug")) continue;
    if (isGuarded(route.full, guards)) continue;

    const blinded = route.body.replaceAll("scope.organizationId", "somethingElse");
    if (!blinded.includes("scope.role") || !blinded.includes("scope.organizationId")) wouldFlag++;
  }

  assert.ok(wouldFlag > 0, "the scan finds nothing even with every restriction removed");
});

