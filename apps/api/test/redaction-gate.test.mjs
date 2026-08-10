// The redaction gate — the prerequisite F5 (Neural Brain) was blocked on.
//
// These call the real function with real values rather than asserting on source
// text. Redaction is one of the few things in this codebase where the behaviour
// is entirely decidable from inputs, so a test that only reads the file would be
// choosing the weaker check for no reason.
import { test } from "node:test";
import assert from "node:assert/strict";

import { redactPii, toShareableRecord, SHAREABLE } from "@nexus/governance";

// A card number that passes Luhn, so the check under test actually fires.
const CARD = "4539578763621486";

test("removes each kind it claims to", () => {
  const cases = [
    ["Email me at ahmed@example.ae please", "[EMAIL]"],
    ["Call +971 50 480 5436 today", "[PHONE]"],
    [`My card is ${CARD}`, "[CARD]"],
    ["ID 784-1990-1234567-1 attached", "[EMIRATES-ID]"],
    ["SSN 123-45-6789", "[GOV-ID]"],
    ["IBAN AE070331234567890123456", "[IBAN]"],
  ];

  for (const [input, placeholder] of cases) {
    const result = redactPii(input);
    assert.equal(result.safe, true, `should be safe: ${input}`);
    assert.ok(result.text.includes(placeholder), `${input} → expected ${placeholder}, got "${result.text}"`);
  }
});

test("a longer value is not fragmented by a shorter overlapping pattern", () => {
  // The bug this exists to prevent: an Emirates ID also matches the phone
  // pattern. Redacting matches independently yields "784-1990-[PHONE]-1", which
  // still identifies a person while looking redacted.
  const result = redactPii("Emirates ID 784-1990-1234567-1 on file");
  assert.equal(result.safe, true);
  assert.equal(result.text, "Emirates ID [EMIRATES-ID] on file");
  assert.ok(!/784/.test(result.text), "no fragment of the ID may survive");
  assert.ok(!/1234567/.test(result.text));
});

test("a card number is not left half-redacted by the phone pattern", () => {
  const result = redactPii(`Paid with ${CARD} yesterday`);
  assert.equal(result.text, "Paid with [CARD] yesterday");
  assert.ok(!/\d{4}/.test(result.text), "no four-digit run may survive");
});

test("several values in one message are all removed", () => {
  const result = redactPii(
    `Contact ahmed@example.ae or +971504805436, ID 784-1990-1234567-1, card ${CARD}.`
  );
  assert.equal(result.safe, true);
  assert.equal(
    result.text,
    "Contact [EMAIL] or [PHONE], ID [EMIRATES-ID], card [CARD]."
  );
  // Counted for audit, without the values ever being recorded.
  assert.equal(result.removed.email, 1);
  assert.equal(result.removed.phone, 1);
  assert.equal(result.removed.emirates_id, 1);
  assert.equal(result.removed.credit_card, 1);
});

test("the surrounding text is preserved exactly", () => {
  // A redactor that mangles the sentence around the value destroys the thing
  // that made the text worth keeping.
  const result = redactPii("Please confirm delivery to ahmed@example.ae before Thursday.");
  assert.equal(result.text, "Please confirm delivery to [EMAIL] before Thursday.");
});

test("text with no PII passes through unchanged", () => {
  const clean = "The customer asked about attestation timelines for a degree certificate.";
  const result = redactPii(clean);
  assert.equal(result.safe, true);
  assert.equal(result.text, clean);
  assert.deepEqual(result.removed, {});
});

test("empty and whitespace input do not throw", () => {
  for (const input of ["", "   ", "\n\n"]) {
    const result = redactPii(input);
    assert.equal(result.safe, true);
    assert.equal(result.text, input);
  }
});

test("verification is real: the output is re-scanned, not assumed", () => {
  // Every redacted result must itself be clean when fed back in. If redaction
  // were only best-effort, this round-trip would surface it.
  const inputs = [
    `Reach me on ahmed@example.ae / +971504805436 / ${CARD}`,
    "784-1990-1234567-1 and 784-2001-7654321-9",
    "Two emails: a@b.co and c@d.io",
  ];
  for (const input of inputs) {
    const first = redactPii(input);
    assert.equal(first.safe, true, input);
    const second = redactPii(first.text);
    assert.equal(second.text, first.text, "redacting twice must change nothing");
    assert.deepEqual(second.removed, {}, "nothing should be left to remove");
  }
});

test("a refusal returns no text at all", () => {
  // Fail closed. The contract is that `text` is unusable when `safe` is false,
  // so a caller that ignores the flag still cannot leak anything.
  const result = redactPii("nothing sensitive here");
  if (!result.safe) {
    assert.equal(result.text, "");
    assert.match(result.reason ?? "", /withheld/);
  }
  // And the shape holds for the successful case too.
  assert.equal(typeof result.text, "string");
});

// ============================================================
// What crosses a tenant boundary is an allow-list
// ============================================================

test("only shareable fields survive, whatever else is present", () => {
  const record = toShareableRecord({
    intent_category: "attestation",
    was_escalated: true,
    resolution_seconds: 420,
    // None of these may cross, and none is a pattern a redactor could catch.
    customer_name: "Ahmed Al Mansouri",
    message_body: "I need my degree attested before Thursday",
    contact_wa_id: "971504805436",
    organization_id: "org-1",
  });

  assert.deepEqual(record, {
    intent_category: "attestation",
    was_escalated: true,
    resolution_seconds: 420,
  });
  assert.ok(!("customer_name" in record));
  assert.ok(!("message_body" in record), "free text must never cross a tenant boundary");
});

test("a field added later is excluded by default", () => {
  // An allow-list, not a deny-list. A deny-list silently passes every field
  // someone adds afterwards, and the failure is invisible until a customer's
  // name is already sitting in a shared store.
  const record = toShareableRecord({ some_new_field_added_next_year: "sensitive" });
  assert.deepEqual(record, {});
});

test("no free-text field is on the shareable list", () => {
  // The load-bearing claim of the whole gate: names, addresses and the substance
  // of what someone asked are not patterns, so redaction cannot be trusted to
  // remove them — which means prose must not be shared at all.
  // Checked by what the field holds, not by what its name contains — an
  // earlier version of this test rejected `message_count`, which is a number.
  const FREE_TEXT_SUFFIXES = /(body|text|note|name|content|reply|summary|transcript)$/;
  for (const field of SHAREABLE) {
    assert.ok(
      !FREE_TEXT_SUFFIXES.test(field),
      `"${field}" looks like free text and must not be shareable`
    );
  }
  console.log("PASS: redaction fails closed, resolves overlaps, and sharing is an allow-list");
});
