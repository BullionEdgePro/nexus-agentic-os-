// An import never reports rows it lost.
//
// FOUND 30 OCT 2026 (final review of Bulk messaging's "+ Add numbers", which
// mirrors this importer). Every /api/* request is ONE database transaction:
// after a Postgres error on row N, Postgres refuses every later row and rolls
// the whole request back at the end — while the importer went on reporting the
// earlier rows as "added". A list that said 40 added could have saved none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const ROUTE = readFileSync(join(root, "apps", "api", "src", "routes", "contacts.ts"), "utf8");

const importHandler = ROUTE.slice(ROUTE.indexOf('contactsRoute.post("/:slug/contacts/import"'));
const handlerBody = importHandler.slice(0, importHandler.indexOf("\n});") + 4);

test("a database error stops the import and says nothing was imported", () => {
  assert.match(handlerBody, /rowFailure\(err\)/);
  assert.match(handlerBody, /if \(failure\.stop\)[\s\S]{0,400}Nothing was imported/);
});

test("our own refusals still refuse one row and carry on", () => {
  // "That does not look like a WhatsApp number" is thrown before any SQL, so
  // the transaction is intact and the rest of the file still imports.
  assert.match(handlerBody, /outcome: "refused",[\s\S]{0,80}reason: failure\.reason/);
});
