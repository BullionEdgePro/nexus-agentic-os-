/**
 * The customer record, and the two ways it could be badly wrong.
 *
 * ============================================================
 * ONE: THE SHARED NUMBER, FOR THE THIRTEENTH TIME
 * ============================================================
 *
 * A contact row is owned by the NUMBER'S OWNER. Ask "who are this business's
 * customers" with `where organization_id = $1` and Zipicka is offered people
 * who have only ever spoken to Juris Prime, while Juris Prime is offered
 * nobody at all — which is the defect this repository has now found twelve
 * times, and the reason `served_organization_ids` exists.
 *
 * The predicate is not written out here a fourth time. It is defined once, in
 * `contactServedBy`, and these tests assert that the readers use it.
 *
 * ============================================================
 * TWO: TWO LAW FIRMS ON ONE PHONE NUMBER
 * ============================================================
 *
 * Juris Prime Legal and ABR both answer on Zipicka's number and are
 * competitors. A screen that assembles a person's whole history in one place is
 * the most sensitive read in this product, and it must show a firm only what
 * that firm was part of: their conversations, their scores, their memory.
 *
 * The detail view is scoped on the SERVING business throughout, never on the
 * owner, and a contact of another firm is a 404 rather than a 403 — telling one
 * firm that a person exists elsewhere on the number is an answer it has no
 * reason to have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { contactServedBy } from "@nexus/db";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "contacts.ts");
const ROUTE = withoutComments(read("apps", "api", "src", "routes", "contacts.ts"));
const PAGE = withoutComments(read("apps", "web", "app", "deck", "customers", "page.tsx"));
const INDEX = read("apps", "api", "src", "index.ts");

// ============================================================
// The shared number
// ============================================================

test("the predicate asks which businesses SERVED them, not who owns the row", () => {
  const sql = contactServedBy("$1");
  assert.match(sql, /\$1::uuid = any \(ct\.served_organization_ids\)/);
  // And the fallback for a contact imported before they ever messaged, whose
  // array is still empty. Without it those people belong to nobody.
  assert.match(sql, /cardinality\(ct\.served_organization_ids\) = 0/);
  assert.match(sql, /ct\.organization_id = \$1/);
});

test("every reader of contacts uses it, none rolls its own", () => {
  // A fourth hand-written copy is how the inbox and the search drifted apart
  // once already -- one was fixed by migration 055 and the other was not, and
  // an employee searching for their own customer by name got nothing at all.
  const uses = DB.split("contactServedBy(").length - 1;
  assert.ok(uses >= 4, `expected the shared predicate at every reader, found ${uses - 1} uses`);

  // Nothing in this module keys a customer question on the owner alone.
  const code = withoutComments(DB);
  assert.ok(
    !/where ct\.organization_id = \$1/.test(code),
    "a reader keys this business's customers on the number's owner"
  );
});

test("a contact's conversations are counted for the SERVING business", () => {
  // conversations.organization_id is the owner too. Counting on it would tell
  // Juris Prime how many conversations their customer had with the letting
  // agent, which is the egress this platform's whole boundary exists to stop.
  const code = withoutComments(DB);
  const owners = code.split("coalesce(c.routed_organization_id, c.organization_id) = $1").length - 1;
  assert.ok(owners >= 3, `conversations must resolve through the serving business, found ${owners}`);
  assert.ok(
    !/from conversations c[\s\S]{0,120}where c\.contact_id = ct\.id\s+and c\.organization_id = \$1/.test(code),
    "a conversation count is keyed on the number's owner"
  );
});

// ============================================================
// One firm, one customer's history
// ============================================================

test("another firm's customer is a 404, not a 403", () => {
  // A 403 confirms the person exists. On a shared number that is a question two
  // competitors could ask about each other's clients.
  assert.ok(ROUTE.includes('return c.json({ error: "Customer not found" }, 404);'));
  assert.ok(!ROUTE.includes("403"), "a distinguishable refusal leaks who exists");
});

test("the screen sits behind the tenant guard rather than a hand-written check", () => {
  // Mounted with a :slug so requireTenantScope pins an employee before anything
  // below runs. A bare /api/contacts would work and would put the only thing
  // between two law firms in a check somebody has to remember to write.
  assert.ok(
    INDEX.includes('app.route("/api/organizations", contactsRoute)'),
    "contacts are not mounted under the per-organization guard"
  );
  const code = withoutComments(INDEX);
  assert.ok(!code.includes('app.route("/api/contacts"'), "a bare, unguarded contacts mount exists");
});

test("only the other firms' NAMES cross, never their conversations", () => {
  // Saying "also a customer of juris-prime" is useful on a shared number and is
  // the business's own operational fact. Their messages are not.
  assert.ok(DB.includes("served_by"), "the detail does not say who else served them");
  assert.ok(
    PAGE.includes("selected.servedBy.filter((s) => s !== business).join"),
    "the screen must list the other businesses by name only"
  );
  assert.ok(
    !PAGE.includes("servedBy.map((s) => getContact"),
    "the screen is fetching another firm's view of this person"
  );
});

// ============================================================
// What is remembered, and erasing it
// ============================================================

test("what the platform remembers is shown in its own words", () => {
  // Summarising a summary is how a person asking "what do you know about me"
  // gets an answer nobody can check -- and somebody deciding whether to erase
  // it cannot decide without reading it.
  assert.ok(ROUTE.includes("summary: memory.summary"), "the remembered text is not returned");
  assert.ok(PAGE.includes("{memory.summary}"), "the screen does not show the remembered text");
});

test("erasing is reachable from a screen, which is the entire point", () => {
  // `forgetContact` has existed since episodic memory shipped, and its own
  // comment says it exists because "delete what you hold about me" is a request
  // a customer can make and "we would have to write some code" is not an
  // answer. Until this route, its only caller was a verification script -- so
  // the honest answer was still "we would have to run something".
  assert.ok(
    ROUTE.includes('contactsRoute.delete("/:slug/contacts/:contactId/memory"'),
    "there is no way to honour a deletion request without running a script"
  );
  assert.ok(ROUTE.includes("forgetContact("), "the route does not call the eraser");
  assert.ok(PAGE.includes("forgetContactMemory("), "the screen offers no way to erase");
});

test("erasing asks first, and says what survives", () => {
  // "Forget this customer" could reasonably be read as deleting the person.
  assert.ok(PAGE.includes("window.confirm("), "an irreversible act happens on one click");
  assert.ok(
    PAGE.includes("Their conversations stay"),
    "the confirmation must say what is NOT erased"
  );
});

test("erasing is authorised before it is performed", () => {
  // RLS would stop the delete matching another firm's row; the explicit check
  // makes the refusal the same shape as every other one here, and turns a
  // silent no-op into a 404.
  const at = ROUTE.indexOf('contactsRoute.delete("/:slug/contacts/:contactId/memory"');
  const body = ROUTE.slice(at);
  const checkAt = body.indexOf("contactBelongsToBusiness(");
  const eraseAt = body.indexOf("forgetContact(");
  assert.ok(checkAt > -1 && eraseAt > -1);
  assert.ok(checkAt < eraseAt, "the erase happens before the caller is authorised");
});

test("erasing nothing is not reported as a failure", () => {
  // "We hold nothing about them" is the state the caller asked for, however it
  // was reached. Returning an error would send somebody hunting for a fault.
  assert.ok(ROUTE.includes("hadMemory: forgotten"));
  assert.ok(!ROUTE.includes('error: "Nothing to erase"'));
});

test("the erased summary is never written to a log", () => {
  // Logging the text being erased on the request that asked for it to be gone
  // would defeat the request.
  const at = ROUTE.indexOf('"A customer\'s remembered summary was erased"');
  assert.ok(at > -1, "an irreversible act is not recorded at all");
  const line = ROUTE.slice(ROUTE.lastIndexOf("logger.info", at), at);
  assert.ok(line.includes("contactId"), "the log does not say whose memory went");
  assert.ok(!line.includes("summary"), "the erased text is being logged");
});

// ============================================================
// The list itself
// ============================================================

test("the list is ordered by when they last spoke, not by score", () => {
  // The question somebody opens this screen with is "who have I been talking
  // to". Sorted by the scorer's number, a data broker outranks a real customer
  // who wrote yesterday.
  assert.ok(DB.includes("order by ct.last_message_at desc nulls last"));
});

test("a failed load does not render as an empty customer list", () => {
  // An empty list under a failed fetch reads as "no customers", which is the
  // sentence this deck exists not to say by accident.
  assert.ok(PAGE.includes("loadError"), "there is no separate load-failure state");
  assert.ok(
    PAGE.indexOf("loadError ? (") < PAGE.indexOf("contacts.length === 0"),
    "the empty state is reached before the failure is reported"
  );
});
