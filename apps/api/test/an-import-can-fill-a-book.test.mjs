// An import can fill a staff member's book.
//
// FOUND 22 OCT 2026. A staff campaign goes to the people in THAT person's book
// (contacts.owner_employee_id), and the customer importer never set it: an
// imported list landed in the business and in nobody's book, so it could never
// be campaigned to. SFS had five staff allowed to send and 0 contacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const ROUTE = readFileSync(join(root, "apps", "api", "src", "routes", "contacts.ts"), "utf8");
const BOOK = readFileSync(join(root, "packages", "db", "src", "client-book.ts"), "utf8");

const importHandler = ROUTE.slice(ROUTE.indexOf('contactsRoute.post("/:slug/contacts/import"'));
const handlerBody = importHandler.slice(0, importHandler.indexOf("\n});") + 4);

test("assignTo must be somebody in this business, checked before any row is touched", () => {
  assert.match(handlerBody, /That person is not in this business\./);
  assert.ok(
    handlerBody.indexOf("That person is not in this business.") < handlerBody.indexOf("ensureContactForServingBusiness("),
    "the check comes before the first row"
  );
});

test("a staff member may fill only their own book; the owner may fill anybody's", () => {
  assert.match(handlerBody, /You can only import into your own book\./);
  assert.match(handlerBody, /role !== "operator"/);
});

test("a contact already in somebody else's book is not moved, and the row says whose", () => {
  assert.match(handlerBody, /already in \$\{[^}]+\}'s book/);
});

test("assigning only ever claims an unowned contact", () => {
  const fn = BOOK.slice(BOOK.indexOf("export async function assignContactOwnerIfUnowned"));
  assert.ok(fn.length > 0, "assignContactOwnerIfUnowned exists");
  assert.match(fn.slice(0, 1500), /where id = \$1\s+and owner_employee_id is null/);
});

test("REVIEW FINDING: a contact on the shared number is still put in the chosen book", () => {
  // ensureContactForServingBusiness files every contact under the business
  // that OWNS the number (Zipicka, for the shared line), so a guard on
  // "owned by this business" skipped every SFS row while reporting "added".
  // A staff book needs the contact SERVED by the business, which the helper
  // guarantees by opening a conversation for it.
  assert.doesNotMatch(handlerBody, /ownerOrganizationId === organization\.id/);
  assert.match(handlerBody, /assignContactOwnerIfUnowned\(result\.contactId, assignee\.id\)/);
});
