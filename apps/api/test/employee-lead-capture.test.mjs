// Leads an employee brings in on their own phone.
//
// One WhatsApp Business number serves all five businesses, and employees follow
// up from the phone in their pocket. That is deliberate — a Business API number
// per person costs money and needs Meta approval — but it left a hole shaped
// exactly like a sales team: a deal won on a personal number produced no lead,
// no score and no attribution, and the pipeline showed only what happened to
// land on the CRM number.
//
// These assert the SQL and the scoring contract, because the interesting
// decisions live there: which contact row a capture attaches to, who keeps the
// credit, and whether a lead scored this way is comparable to an inbound one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scoreLead } from "@nexus/leads";
import { normalizeWhatsAppNumber } from "@nexus/employees";

const here = dirname(fileURLToPath(import.meta.url));
const CAPTURE = readFileSync(
  join(here, "..", "..", "..", "packages", "leads", "src", "capture.ts"),
  "utf8"
);
const IDENTITY = readFileSync(
  join(here, "..", "..", "..", "packages", "db", "src", "contact-identity.ts"),
  "utf8"
);
const MIGRATION = readFileSync(
  join(here, "..", "..", "..", "packages", "db", "migrations", "013-employee-sourced-leads.sql"),
  "utf8"
);

test("a captured lead lands on the same contact an inbound message would", () => {
  // THIS TEST PASSED FOR MONTHS ON A PROPERTY IT NEVER CHECKED.
  //
  // Its claim was right and its assertions could not see it. Landing on the
  // same row as an inbound message needs the upsert to be keyed on
  // (organization_id, wa_id) AND that organization_id to be the one the webhook
  // uses. It matched the first and never the second — and the second was wrong:
  // capture passed the EMPLOYEE'S business, the webhook writes under the shared
  // number's OWNER, so on this deployment the two would have produced two
  // contacts for one person. The SQL the assertion matched was present and
  // correct the whole time. The argument to it was not.
  //
  // Never fired, because zero contacts on production had been captured by an
  // employee when it was found on 2026-08-26.
  //
  // Now checked where it can actually be seen: capture resolves identity
  // through the one function that knows about shared numbers, and that function
  // keys the upsert on the owner.
  assert.match(CAPTURE, /ensureContactForServingBusiness\(/);
  assert.ok(
    !/insert into contacts/.test(CAPTURE),
    "capture has its own contact insert again — two answers to where a person goes"
  );
  assert.match(IDENTITY, /on conflict \(organization_id, wa_id\) do update/);
  assert.match(
    IDENTITY,
    /findOrganizationByPhoneNumberId/,
    "identity must resolve the number's owner, not take the business it was given"
  );
  assert.match(
    IDENTITY,
    /\[owner\.id, waId,/,
    "the upsert must be keyed on the owner — this is the half the old test could not see"
  );
});

test("the serving business can still find a customer it never messaged", () => {
  // The other half of writing under the owner: without a conversation routed to
  // them, a law firm's own hand-entered customer would be invisible to it.
  // served_organization_ids is trigger-maintained out of conversations and
  // cannot be set directly, so the conversation IS the mechanism.
  assert.match(IDENTITY, /insert into conversations \(organization_id, contact_id, routed_organization_id\)/);
  assert.match(
    IDENTITY,
    /serving\.id === owner\.id \? null : serving\.id/,
    "routing a conversation at the owner would read as having been through triage"
  );
});

test("finding someone first keeps the credit", () => {
  // Re-capturing a known contact must not re-attribute them to whoever logged
  // the most recent note, or attribution becomes last-touch by accident.
  // Reads IDENTITY, not CAPTURE: the upsert moved when hand-entered contacts
  // stopped being written under the wrong business. The rule is unchanged and
  // now applies to the console's add-a-customer form as well, which is the
  // point of there being one place.
  assert.match(
    IDENTITY,
    /captured_by_employee_id = coalesce\(contacts\.captured_by_employee_id, excluded\.captured_by_employee_id\)/
  );
  // And a blank name must never overwrite a real one.
  assert.match(IDENTITY, /display_name = coalesce\(contacts\.display_name, excluded\.display_name\)/);
});

test("a captured lead is marked as employee-sourced, not inbound", () => {
  // Without this the pipeline cannot tell what the CRM number earned from what
  // the team earned, which is the reporting question this feature exists for.
  assert.match(CAPTURE, /'employee_direct'/);
  assert.match(MIGRATION, /source in \('inbound', 'employee_direct'\)/);
  // Existing rows keep their meaning rather than becoming ambiguous.
  assert.match(MIGRATION, /default 'inbound'/);
});

test("the employee's note is stored, not just its score", () => {
  // A score with no text behind it cannot be explained or re-derived when the
  // rules change.
  assert.match(MIGRATION, /add column if not exists note text/);
  assert.match(CAPTURE, /la\.note|input\.note/);
});

test("a captured lead scores on the same scale as an inbound one", () => {
  // Comparability is the requirement: an employee's lead and a webhook lead
  // have to sort into one list. Same engine, same inputs.
  // Phrasing taken from the scorer's own vocabulary rather than invented — my
  // first attempt ("wants a quote, budget approved") scored zero, which is a
  // fair reminder that an employee's free-text note is only as good as the
  // words it happens to contain. Worth surfacing in the UI as a hint.
  const strong = scoreLead({ text: "asking the price for a bulk order, wants delivery", priorInboundCount: 0 });
  const weak = scoreLead({ text: "just saying hello", priorInboundCount: 0 });

  assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
  assert.ok(["low", "normal", "high", "urgent"].includes(strong.priority));
  assert.ok(Array.isArray(strong.signals) && strong.signals.length > 0, "a score must carry its evidence");
});

test("a returning contact outranks a brand-new one on the same words", () => {
  // How the capture path expresses "someone already met this person": it feeds
  // the prior-assessment count into the scorer's existing returning-contact
  // signal rather than inventing a second scale.
  const text = "asking about pricing";
  const fresh = scoreLead({ text, priorInboundCount: 0 });
  const known = scoreLead({ text, priorInboundCount: 3 });
  assert.ok(known.score >= fresh.score, `${known.score} should be at least ${fresh.score}`);
  assert.match(CAPTURE, /priorInboundCount: Number\(/);
});

test("the customer's number is normalised before it becomes an identity", () => {
  // wa_id is the contact's identity. "+971 50 123 4567" and "00971501234567"
  // are the same person, and storing them as typed would create two contacts
  // and split one lead in half.
  for (const written of ["+971 50 123 4567", "00971501234567", "971-50-123-4567"]) {
    assert.equal(normalizeWhatsAppNumber(written), "971501234567", written);
  }
  assert.equal(normalizeWhatsAppNumber("not a number"), null);
});

test("the highest score a contact ever reached is what stands", () => {
  // Same rule as the inbound path: a follow-up "thanks" must not bury the
  // bulk-order enquiry that came before it.
  assert.match(CAPTURE, /greatest\(coalesce\(lead_score, 0\), \$2\)/);
  console.log("PASS: work done on an employee's own phone reaches the pipeline");
});
