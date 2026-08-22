// "Failed to fetch" is a browser's word, shown to somebody who runs a shop.
//
// Seen on the real operators deck with the API unreachable. It is not wrong; it
// is simply not addressed to the person reading it, and it names no action.
//
// A helper already existed to fix exactly this, carrying a comment saying it
// had been written twice before being centralised. It was then adopted in four
// files and bypassed in twenty-seven, all of them shaped like:
//
//   err instanceof Error ? err.message : "Could not load the diary."
//
// which reads like a careful fallback and is not one. The sentence only fires
// when the thrown thing is NOT an Error — which for a fetch failure or an API
// error never happens. So the sentence somebody wrote is dead code, and what
// ships is err.message: "Failed to fetch", or the whole transport string with
// the human part buried inside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");
const API = readFileSync(join(web, "lib", "api.ts"), "utf8");

/**
 * Every source file that could put words in front of a person.
 *
 * .ts AS WELL AS .tsx, AND lib/ AS WELL AS app/. The first version took only
 * .tsx under app/, which is where components live -- and the inbox does not
 * fetch from a component. It fetches through lib/store.ts, so all three of its
 * error slots were invisible to the sweep AND to this check, and the inbox went
 * on showing "Failed to fetch" with the suite green.
 *
 * A check scoped to where you expect the bug is a check that finds the bugs you
 * expected.
 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** app/ and lib/ both. The API client itself is the one file exempt below. */
function sources() {
  return [...walk(join(web, "app")), ...walk(join(web, "lib"))];
}

/**
 * The helper, evaluated for real.
 *
 * Reading the source and asserting on branches would test that the code looks
 * right. This runs it, which is the only way to know what a person is shown.
 */
function readableError(err, whenUnreachable) {
  // SIGNATURE-INDEPENDENT. The first harness stripped the declaration by
  // matching its exact text, so adding a second parameter to the real function
  // silently left the declaration inside the generated body and every case in
  // this file failed at once. It now finds the braces instead, which is the
  // only part of a function that cannot be reworded.
  const at = API.indexOf("export function readableError");
  const open = API.indexOf("{", at);
  let depth = 0;
  let close = open;
  for (let i = open; i < API.length; i++) {
    if (API[i] === "{") depth++;
    else if (API[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = API.slice(open + 1, close);
  return new Function("err", "whenUnreachable", body)(err, whenUnreachable);
}

test("the API's own sentence wins, because somebody wrote it for a person", () => {
  const err = new Error('API 400 on /api/procedures: {"error":"Another procedure for this kind of enquiry is already active"}');
  assert.equal(readableError(err), "Another procedure for this kind of enquiry is already active");
});

test("a status we reached is never reported as a connection problem", () => {
  // THE BUG THIS BRANCH EXISTS FOR. Falling through to "check the connection"
  // on a 403 sends somebody to reboot a router over a permissions error.
  const forbidden = readableError(new Error("API 403 on /api/quality: forbidden"));
  assert.ok(!/connection/i.test(forbidden), forbidden);
  assert.match(forbidden, /cannot see this/);

  const server = readableError(new Error("API 503 on /api/tasks: upstream down"));
  assert.ok(!/connection/i.test(server), server);
  assert.match(server, /platform had a problem/);
});

test("an expired session says so, even though the server said Unauthorized", () => {
  // THIS TEST USED TO PASS WITHOUT MEANING ANYTHING. It sent a 401 with an
  // EMPTY body, so the server-message branch never matched and the ordering it
  // was meant to check never came up. Driving the real screen showed the deck
  // rendering a bare "Unauthorized" while this was green.
  //
  // The body below is what the API actually sends. The TTL is 12 hours, so this
  // is the likeliest thing anybody meets after leaving a tab open overnight, and
  // the only one with a one-step fix — which "Unauthorized" does not mention.
  const real = new Error('API 401 on /api/operators: {"error":"Unauthorized"}');
  assert.match(readableError(real), /session expired.*[Ss]ign in/);
  assert.ok(!/Unauthorized/.test(readableError(real)));
});

test("401 is the only status that outranks the server's own words", () => {
  // Everywhere else the server wrote its message about the actual request, and
  // it is better than anything this helper could infer from a number.
  const conflict = new Error('API 409 on /api/procedures: {"error":"Another procedure for this kind of enquiry is already active"}');
  assert.equal(readableError(conflict), "Another procedure for this kind of enquiry is already active");
  const forbidden = new Error('API 403 on /api/quality: {"error":"Operators only"}');
  assert.equal(readableError(forbidden), "Operators only");
});

test("only a genuine unreachable host mentions the connection", () => {
  // fetch() rejects with a bare TypeError and a message that differs per
  // browser and means nothing to the reader. This is the one branch where the
  // connection really is the thing to check.
  assert.match(readableError(new TypeError("Failed to fetch")), /Could not reach the platform/);
  assert.match(
    readableError(new TypeError("NetworkError when attempting to fetch resource.")),
    /Could not reach the platform/
  );
});

test("no screen surfaces a raw error message any more", () => {
  // The shape that made the written fallbacks dead code.
  const offenders = [];
  for (const file of sources()) {
    const src = readFileSync(file, "utf8");
    // lib/api.ts is where readableError itself unwraps the Error, which is the
    // one place this shape is the right code rather than the bug.
    if (file.endsWith(join("lib", "api.ts"))) continue;
    if (/err instanceof Error \? err\.message/.test(src)) {
      offenders.push(file.slice(web.length + 1));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these show the browser's words to a shop owner:\n  " + offenders.join("\n  ")
  );
});

test("every screen that catches an error routes it through the helper", () => {
  // SCOPED TO FILES THAT USE THE SHARED CLIENT, which is what the helper
  // decodes. `request()` throws "API 404 on /path: {...}"; readableError exists
  // to unpack exactly that shape, so a file which never calls request() has
  // nothing for it to unpack.
  //
  // The admin sign-in page is the real case that forced this: it posts to a
  // same-origin Next route with bare fetch, reads `body.error` straight off the
  // JSON, and falls back to the same connection sentence by hand. Routing it
  // through the helper would be worse, not better — it already has the parsed
  // body, and the helper would only get a string to re-parse.
  const offenders = [];
  for (const file of sources()) {
    if (file.endsWith(join("lib", "api.ts"))) continue;
    const src = readFileSync(file, "utf8");
    // Either import form: components use the alias, lib/ uses a relative path.
    const usesSharedClient = /from "@\/lib\/api"|from "\.\/api"/.test(src);
    const surfaces = /set(Error|LoadError|SendError)\(/.test(src) || /kind: "error"/.test(src);
    if (usesSharedClient && surfaces && !src.includes("readableError")) {
      offenders.push(file.slice(web.length + 1));
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});
