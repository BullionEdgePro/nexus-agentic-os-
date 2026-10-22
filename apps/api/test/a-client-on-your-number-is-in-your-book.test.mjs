// A customer who writes to your own number is in your book.
//
// FOUND 22 OCT 2026. Keshav Arora (SFS) had three customers chatting on his own
// WhatsApp number and a client book of zero: an inbound on a staff number put
// the CONVERSATION in their hands but never the contact in their book
// (contacts.owner_employee_id). A staff campaign goes to the book, so it could
// never reach the people a staff member actually talks to — and the campaign
// checklist promised "clients who message your number join your book".
//
// Claimed only when nobody owns them: a customer already in a colleague's book
// stays there (moving clients is the owner's call, not a side effect).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PROCESSOR = readFileSync(join(here, "..", "src", "queue", "processor.ts"), "utf8");
const handler = PROCESSOR.slice(PROCESSOR.indexOf("async function handleStaffNumberMessage("));
const body = handler.slice(0, handler.indexOf("\n}\n"));

test("an inbound on a staff number puts an unowned customer in that person's book", () => {
  assert.match(body, /assignContactOwnerIfUnowned\(result\.contactId, employee\.id\)/);
});

test("it happens inside the staff member's own business scope, with the routing", () => {
  const scoped = body.slice(body.indexOf("await withTenant(employee.organizationId"));
  assert.ok(scoped.indexOf("assignContactOwnerIfUnowned(") > 0);
  assert.ok(scoped.indexOf("assignContactOwnerIfUnowned(") < scoped.indexOf("});"));
});
