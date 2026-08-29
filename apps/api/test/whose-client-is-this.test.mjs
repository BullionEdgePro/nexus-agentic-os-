/**
 * One staff member's book is not another's.
 *
 * ============================================================
 * THE SAME SHAPE AS THE BUG BEFORE IT
 * ============================================================
 *
 * `contacts` now carries two pools on one table: the business's shared list,
 * and each staff member's own clients. The difference between them is a single
 * predicate, and a query that omits it does not fail — it returns MORE rows,
 * all of them plausible, none of them refused by anything.
 *
 * That is precisely the shape of the defect this repository has now found
 * fourteen times with `organization_id`, and it was found a fifteenth time
 * during this very feature: `claimClient` was written filtering contacts by
 * organization_id, which on a shared number is the NUMBER OWNER's business, not
 * the staff member's. The existing gate caught it before it shipped. This one
 * exists so the employee axis is watched the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { filtersContactsByOrg } from "./whose-customers-are-these.test.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const BOOK = read("packages", "db", "src", "client-book.ts");
const DESK = read("apps", "api", "src", "routes", "my-desk.ts");

// ============================================================
// The predicate exists once and is used everywhere
// ============================================================

test("the ownership predicate is defined in one place", () => {
  assert.match(BOOK, /export function contactOwnedBy/);
  assert.match(BOOK, /export function contactVisibleTo/);
});

test("every read and write of a client book carries both predicates", () => {
  // Both axes, every time. The tenant predicate says which business's people
  // these are; the ownership predicate says whose of those. Either one alone
  // returns a plausible, wrong list.
  for (const fn of ["listMyClients", "releaseClient", "updateClientDetails"]) {
    const body = BOOK.slice(BOOK.indexOf(`export async function ${fn}`));
    const sql = body.slice(0, body.indexOf("\n}"));
    assert.match(sql, /contactServedBy\("\$1"\)/, `${fn} does not scope to the business`);
    assert.match(sql, /contactOwnedBy\("\$2"\)/, `${fn} does not scope to the person`);
  }
});

test("claiming scopes to the business and refuses one already owned", () => {
  // Not contactOwnedBy: claiming is the one operation whose target is by
  // definition NOT yet yours. What it must never do is take one that is
  // somebody else's, which is `owner_employee_id is null`.
  const body = BOOK.slice(BOOK.indexOf("export async function claimClient"));
  const sql = body.slice(0, body.indexOf("\n}"));
  assert.match(sql, /contactServedBy\("\$1"\)/);
  assert.match(
    sql,
    /ct\.owner_employee_id is null/,
    "claiming can now take a colleague's client"
  );
});

test("no client-book query filters contacts by organization_id", () => {
  // Reuses the scanner the older gate exports, pointed at this file. On a
  // shared number a contact row belongs to the number's owner, so
  // organization_id answers a different question than the one being asked.
  const offenders = [];
  for (const sql of sqlLiterals(BOOK)) {
    if (/\bwa_id\s*=/.test(sql)) continue; // identity lookup, correctly keyed
    if (filtersContactsByOrg(sql)) offenders.push(sql.replace(/\s+/g, " ").slice(0, 100));
  }
  assert.deepEqual(offenders, [], "these ask the wrong question and return rows anyway");
});

// ============================================================
// The endpoints cannot be pointed at somebody else
// ============================================================

test("no desk endpoint takes an employee id from the caller", () => {
  // The whole boundary. An endpoint under /my that accepts an id is an endpoint
  // for reading a colleague's book, and it would look almost identical in a
  // diff — the only visible difference is where the id comes from.
  assert.ok(
    !/employeeId:\s*c\.req\.(param|query|header)/.test(DESK),
    "an employee id is being read from the request"
  );
  assert.ok(
    !/body\.employeeId/.test(DESK),
    "an employee id is being read from the request body"
  );
  // Every handler resolves the person from the session instead.
  assert.match(DESK, /employeeId: scope\.employeeId/);
});

test("an operator is refused rather than shown an empty book", () => {
  // An operator has no employee record. Returning an empty list would read as
  // "you have no clients" — a fact about a book that does not exist.
  assert.match(DESK, /scope\.role !== "employee" \|\| !scope\.employeeId/);
  assert.match(DESK, /403/);
});

test("a staff-view preview is named in the refusal", () => {
  // The owner previewing a business has role employee and no employeeId, so
  // they land here. Saying something generic about roles would leave them
  // hunting for a permission problem that does not exist.
  assert.match(DESK, /previewing a business/);
});

// ============================================================
// The channel tells the truth
// ============================================================

test("connected means Meta says so, not that somebody typed it", () => {
  // A number in our own table is a claim. The WABA listing is the fact, and the
  // two disagree the moment a number is removed at Meta.
  assert.match(DESK, /listWabaNumbers/);
  assert.match(DESK, /claimed-but-not-on-the-account/);
});

/**
 * Prose in JSX wraps wherever the formatter decides, so a sentence in the
 * source is rarely a sentence on one line. Matching the raw file makes these
 * assertions fail on a reflow that changed no words -- collapse first, then
 * look for the wording.
 */
const prose = () =>
  read("apps", "web", "app", "deck", "my-clients", "page.tsx").replace(/\s+/g, " ");

test("the shared number is never presented as a private one", () => {
  const CHANNEL = prose();
  assert.match(CHANNEL, /shared number/);
  assert.match(
    CHANNEL,
    /Your clients see the company, not you/,
    "the shared-number state no longer says whose name the customer sees"
  );
});

test("the console says a personal WhatsApp cannot be connected", () => {
  // The single most likely wrong belief a staff member can hold about this
  // screen, and the one that produces a campaign nobody receives.
  const CHANNEL = prose();
  assert.match(CHANNEL, /has no way to be read by software/);
});

// Local copy of the literal scanner: importing it would mean exporting a second
// helper from the older gate purely for this file's convenience.
function sqlLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i + 1;
    let depth = 0;
    while (j < src.length) {
      if (src[j] === "$" && src[j + 1] === "{") {
        depth += 1;
        j += 2;
        continue;
      }
      if (depth > 0 && src[j] === "}") {
        depth -= 1;
        j += 1;
        continue;
      }
      if (depth === 0 && src[j] === "`") break;
      j += 1;
    }
    out.push(src.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}
