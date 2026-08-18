// Every outbound message in this database claimed it was sent. None of them knew.
//
// Measured on production the day this was written: 24 outbound rows, all
// `status = 'sent'`, and 0 with a `wa_message_id`. Same cause for both —
// `insertOutboundMessage` wrote the literal 'sent', and `sendWhatsAppText`
// discarded the response body, so Meta's receipt was never stored. The status
// webhook that would have corrected it arrived on the same endpoint as every
// inbound message, was counted in one log line, and was dropped.
//
// A 200 from the Graph API means ACCEPTED, not delivered. So a reply Meta
// accepted and then failed to deliver was indistinguishable — in the inbox, in
// the database, and in every rollup computed from them — from one the customer
// read. These tests pin the parts of the fix that are easy to get subtly wrong
// and impossible to notice: the ladder, the tenant the receipt is applied in,
// and the operator's ability to see an absence rather than an error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DELIVERY_STATUS_LADDER } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const CLIENT = read("apps", "api", "src", "lib", "whatsapp-client.ts");
const MESSAGES = read("packages", "db", "src", "messages.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const WEBHOOK = read("apps", "api", "src", "webhook", "whatsapp.ts");
const MIGRATION = read("packages", "db", "migrations", "048-delivery-receipts.sql");
const ROUTES = read("apps", "api", "src", "routes", "conversations.ts");

test("the send returns Meta's receipt instead of throwing it away", () => {
  // Both senders returned void, which is why wa_message_id was null on every
  // outbound row ever written. The status webhook identifies a message by that
  // id and by nothing else, so discarding it made delivery unknowable rather
  // than merely unknown.
  assert.match(CLIENT, /export async function sendWhatsAppText\([\s\S]*?\): Promise<SentMessageId>/);
  assert.match(CLIENT, /bodyParams: string\[\] = \[\]\r?\n\): Promise<SentMessageId>/);

  // Read defensively: a missing id is not a failed send. Meta accepted it.
  assert.match(CLIENT, /function readWamid/);
  assert.ok(
    !/throw new Error\(["'`]no wamid/i.test(CLIENT),
    "a missing receipt must not turn an accepted send into a failure"
  );
});

test("'sent' stops being a claim the insert makes on Meta's behalf", () => {
  // The literal is gone. With a receipt to follow the honest state is 'queued'
  // — accepted, not yet confirmed — and the webhook moves it from there.
  assert.match(
    MESSAGES,
    /case when \$4::text is null then 'sent' else 'queued' end/,
    "outbound status must depend on whether a receipt exists to follow"
  );

  // Without a wamid there will never be a receipt. Parking those at 'queued'
  // forever would have the operator report a permanent backlog of messages
  // that were fine — a false alarm that never clears is worse than none.
  assert.ok(!/values \(\$1, \$2, \$3, \$4, 'outbound'[\s\S]{0,200}'sent',/.test(MESSAGES));
});

test("a late receipt cannot walk a message backwards", () => {
  // Meta does not promise order: 'sent', 'delivered' and 'read' arrive on
  // separate webhook deliveries and each can be retried. Applied blindly, a
  // late 'sent' overtaking an early 'read' marks a message the customer has
  // already read as still in flight — and the operator then reports it stuck.
  assert.deepEqual([...DELIVERY_STATUS_LADDER], ["queued", "sent", "delivered", "read"]);

  // 'failed' is deliberately NOT a rung: terminal, reachable from any point,
  // and nothing may move a message off it.
  assert.ok(!DELIVERY_STATUS_LADDER.includes("failed"));

  // The guard lives in the WHERE clause, not in a read-then-write, which would
  // race two webhooks against each other.
  assert.match(
    MESSAGES,
    /coalesce\(array_position\(\$4::text\[\], \$2\), 0\)\s*>\s*coalesce\(array_position\(\$4::text\[\], status\), 0\)/
  );
  assert.match(MESSAGES, /\(\$2 = 'failed' and status <> 'failed'\)/);

  // ONE ladder, not a TypeScript one and a SQL one that agree until somebody
  // edits either. The array is passed to Postgres as a parameter.
  assert.match(MESSAGES, /\[\.\.\.DELIVERY_STATUS_LADDER\]/);
  assert.ok(!/array\['queued'/.test(MESSAGES), "the order must not be re-typed inside the SQL");
});

test("a later status must not erase why a message failed", () => {
  // `delivery_error` is the most useful thing on a failed row.
  assert.match(MESSAGES, /delivery_error = coalesce\(\$3, delivery_error\)/);
});

test("the receipt is applied as the number's OWNER, which is the unusual answer here", () => {
  // Five businesses share one number and `insertOutboundMessage` writes the
  // OWNER's organization_id on every outbound row, whichever business was
  // answering. So the owner's context is the only one that can see the row.
  // Scoping to the serving business would match nothing and silently discard
  // every receipt — the shared-number trap wearing a third face.
  const fn = PROCESSOR.slice(
    PROCESSOR.indexOf("async function processDeliveryStatuses"),
    PROCESSOR.indexOf("function describeStatusError")
  );
  assert.match(fn, /findOrganizationByPhoneNumberId/);
  assert.match(fn, /withTenant\(organization\.id/);
  assert.ok(!/withServingTenant/.test(fn), "the serving business cannot see the owner's outbound row");
});

test("a status webhook never reaches the agent", () => {
  // A receipt carries no customer message, starts no conversation, and must not
  // put a Meta callback on the reply path — the one path that must not acquire
  // new ways to fail. Hence its own function, called beside the message loop.
  assert.match(PROCESSOR, /await processDeliveryStatuses\(phoneNumberId, change\);/);

  const fn = PROCESSOR.slice(
    PROCESSOR.indexOf("async function processDeliveryStatuses"),
    PROCESSOR.indexOf("function describeStatusError")
  );
  for (const forbidden of ["routeToEmployeeTwin", "processSingleTextMessage", "sendWhatsAppText"]) {
    assert.ok(!fn.includes(forbidden), forbidden + " must not run on a delivery receipt");
  }

  // Swallowed per status: a receipt records something that already happened, and
  // throwing would make BullMQ retry the whole webhook and re-deliver the
  // customer messages beside it.
  assert.match(fn, /catch \(err\) \{[\s\S]*?logger\.warn/);
});

test("Meta's reason survives in Meta's own words", () => {
  // "re-engagement message" and "recipient has not accepted our new terms" call
  // for completely different actions. A normalised code of our own invention
  // would throw away exactly the part somebody needs.
  assert.match(PROCESSOR, /function describeStatusError/);
  assert.match(PROCESSOR, /error_data\?\.details/);
  assert.match(MIGRATION, /add column if not exists delivery_error text/);
});

test("every send site carries the receipt, not just the convenient one", () => {
  // Four call sites: the agent's reply, the triage menu, the AI-failure
  // fallback, and a human's own words from the inbox. A site that forgot would
  // write a row that can never be corrected, and nothing would say so.
  const sites = PROCESSOR.match(/waMessageId: waMessageId \?\? undefined/g) ?? [];
  assert.equal(sites.length, 3, "all three processor send sites must pass the receipt");
  assert.match(ROUTES, /waMessageId: waMessageId \?\? undefined/);
});

test("a status-only webhook has a stable identity", () => {
  // It used to fall through to Date.now(), which is not an identity: two
  // receipts in the same millisecond collided on one jobId and BullMQ dropped
  // the second, while Meta redelivering the SAME receipt produced a fresh id
  // and processed it twice. Neither mattered while statuses were being ignored.
  assert.match(WEBHOOK, /value\?\.statuses\?\.\[0\]\?\.id/);
});

test("the operator can see an absence, not only an error", () => {
  const operator = OPERATORS.slice(
    OPERATORS.indexOf("const deliveryFailing"),
    OPERATORS.indexOf("export const OPERATORS")
  );

  // 'failed' is the easy half. The half worth having is 'queued' past a grace
  // period: Meta accepted it and has since said nothing, so there is no error
  // to find — which is the shape almost every defect on this platform has taken.
  assert.match(operator, /status = 'failed'/);
  assert.match(operator, /status = 'queued'/);
  assert.match(operator, /UNCONFIRMED_GRACE_MINUTES/);

  // Urgent only when a customer definitely missed a reply. An operator that
  // cried outage over a slow webhook would be switched off, taking the real
  // alarm with it.
  assert.match(operator, /severity: failed > 0 \? \("urgent" as const\) : \("warn" as const\)/);

  // Registered. An operator that exists and is not in the list is a feature
  // that reports itself as built and never runs.
  assert.match(OPERATORS, /^\s*deliveryFailing,\s*$/m);
});

test("nothing may delete a message", () => {
  // Same reasoning as 042 for catalog_installs, and it matters more here: these
  // rows are the record of what a business actually said to a customer, and
  // every other guarantee — the governance evaluation, the handover brief, the
  // quality rollups, an operator's evidence — is computed from them. Nothing in
  // the codebase deletes one, so the grant could only ever be exercised by
  // accident or by injection. UPDATE stays: that is how a receipt lands.
  assert.match(MIGRATION, /revoke all on messages from nexus_app/);
  assert.match(MIGRATION, /grant select, insert, update on messages to nexus_app/);
  assert.ok(!/grant delete/i.test(MIGRATION));
});

test("the wamid index is not unique, and that is deliberate", () => {
  // Tempting, since a wamid is globally unique at Meta. But Meta redelivers
  // webhooks, and a duplicate inbound insert that currently produces a
  // redundant row would start producing a constraint violation, a failed job
  // and a retry loop — in the reply path — to fix a cosmetic problem.
  assert.match(MIGRATION, /create index if not exists messages_wa_message_id_idx/);
  assert.ok(
    !/create unique index[^;]*messages \(wa_message_id\)/.test(MIGRATION),
    "deduplication belongs with the inbound insert, not smuggled in here"
  );
});
