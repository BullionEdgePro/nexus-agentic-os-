/**
 * Every write the console can make has a route on the other end.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Asked whether the features were "set up so the data can be put in", and the
 * honest way to answer it was to check rather than to look at the screens. All
 * fifteen deck pages exist, all carry an empty state, and seven carry a create
 * path -- but a button whose endpoint was renamed underneath it looks exactly
 * like a button that works, right up to the moment somebody sits down to enter
 * a week of real data and gets a 404 they cannot read.
 *
 * Nothing else catches this. The client is a hand-written list of `request()`
 * calls with template-literal paths; the server is 28 routers mounted at bases
 * that are themselves strings. TypeScript checks both sides and can see no
 * relationship between them, and no test called a route by URL until
 * serving-check.
 *
 * ============================================================
 * WHAT IT PROVES AND WHAT IT DOES NOT
 * ============================================================
 *
 * It proves a POST/PUT/PATCH/DELETE in `lib/api.ts` matches a handler mounted
 * at that path. It says nothing about the BODY being right, nor about
 * authorisation -- a call can reach a route and still be refused. Both are
 * worth having and this is the cheap half.
 *
 * Reads are deliberately not covered. A GET that 404s renders an empty screen
 * that the reader can see is empty; a failed write loses the thing they typed.
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

/** Every write the console can make: path template and verb. */
function clientWrites() {
  const out = [];
  const re = /request(?:<[^>]*>)?\(\s*`([^`]+)`\s*,\s*\{([^}]*method:\s*"(POST|PUT|PATCH|DELETE)"[^}]*)\}/g;
  let m;
  while ((m = re.exec(CLIENT))) out.push({ path: m[1], method: m[3] });
  return out;
}

/** Every handler the API mounts, as a full path. */
function serverHandlers() {
  const importedFrom = {};
  const ire = /import\s+\{?\s*([\w\s,]+?)\s*\}?\s+from\s+"\.\/routes\/([\w-]+)(?:\.js)?"/g;
  let m;
  while ((m = ire.exec(INDEX))) {
    for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      importedFrom[name] = m[2];
    }
  }

  const out = [];
  const mre = /app\.route\(\s*"([^"]+)"\s*,\s*(\w+)/g;
  while ((m = mre.exec(INDEX))) {
    const [, base, varName] = m;
    const file = importedFrom[varName];
    if (!file) continue;
    let src;
    try {
      src = read("apps", "api", "src", "routes", `${file}.ts`);
    } catch {
      continue;
    }
    const hre = new RegExp(`${varName}\\.(get|post|put|patch|delete)\\(\\s*"([^"]*)"`, "g");
    let h;
    while ((h = hre.exec(src))) {
      out.push({ method: h[1].toUpperCase(), pattern: (base + h[2]).replace(/\/$/, "") || "/" });
    }
  }
  return out;
}

/** A `:param` in a route matches an interpolated hole in a client path. */
function matches(pattern, concrete) {
  const source = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`).test(concrete);
}

const WRITES = clientWrites();
const HANDLERS = serverHandlers();

test("the parser still recognises both sides", () => {
  // A CHECK THAT CANNOT FAIL IS DECORATION, and this one is two regexes away
  // from silently passing forever. The first version of it found zero handlers
  // -- the imports carry a `.js` extension its pattern did not allow -- and
  // reported all 37 writes as broken. The opposite slip is the dangerous one:
  // match nothing on the CLIENT side and every assertion below is vacuously
  // true, on a test whose whole subject is things that quietly stopped being
  // connected.
  //
  // Floors, not exact counts, so adding a screen does not fail this.
  assert.ok(WRITES.length >= 30, `only ${WRITES.length} client writes found — the parser has stopped matching`);
  assert.ok(HANDLERS.length >= 60, `only ${HANDLERS.length} route handlers found — the parser has stopped matching`);
});

test("every create, update and delete the console offers reaches a route", () => {
  const orphans = [];
  for (const write of WRITES) {
    // `${...}` becomes one path segment; the query string is not routed on.
    const concrete = write.path.replace(/\$\{[^}]*\}/g, "X").split("?")[0].replace(/\/$/, "") || "/";
    const found = HANDLERS.some((h) => h.method === write.method && matches(h.pattern, concrete));
    if (!found) orphans.push(`${write.method} ${write.path}`);
  }

  assert.deepEqual(
    orphans,
    [],
    `the console can make ${orphans.length} write(s) that no route answers:\n  ${orphans.join("\n  ")}`
  );
});
