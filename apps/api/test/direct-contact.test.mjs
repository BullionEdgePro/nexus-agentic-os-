// The bridge from the platform's one WhatsApp number to an employee's own.
//
// Employees don't get Business API numbers — each one costs money and needs
// Meta approval — so they message assigned customers from the WhatsApp already
// on their phone. This is the link that opens.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDirectContact, normalizeWhatsAppNumber } from "@nexus/employees";

const IVAN = { fullName: "Ivan Cruz", jobTitle: "Senior Consultant", whatsappNumber: "+971 50 123 4567" };

test("numbers are accepted however a person writes them", () => {
  // The same UAE mobile, five ways someone might type it into a form.
  for (const written of ["+971501234567", "00971501234567", "971 50 123 4567", "+971-50-123-4567", "(971) 50 123 4567"]) {
    assert.equal(normalizeWhatsAppNumber(written), "971501234567", written);
  }
});

test("a number that cannot be dialled internationally is refused, not guessed", () => {
  // A bad link does not fail loudly — WhatsApp just opens and says the number
  // is invalid, which reads as "this customer isn't on WhatsApp" rather than
  // "we stored a bad number". Refusing to build it is the honest failure.
  for (const bad of ["", "   ", "12345", "abc", null, undefined, "1".repeat(16)]) {
    assert.equal(normalizeWhatsAppNumber(bad), null, JSON.stringify(bad));
  }
});

test("the link opens the customer's chat with an introduction already written", () => {
  const contact = buildDirectContact({
    employee: IVAN,
    businessName: "Juris Prime Legal",
    customerWaId: "971500000002",
    customerName: "Sara",
  });

  assert.ok(contact, "a valid customer number must produce a link");
  assert.ok(contact.url.startsWith("https://wa.me/971500000002?text="), contact.url);

  // The customer is about to get a message from a number they have never seen.
  // Without a name, a role and the business it reads as spam — which is the
  // difference between a warm handoff and a blocked contact.
  assert.match(contact.message, /Sara/);
  assert.match(contact.message, /Ivan Cruz/);
  assert.match(contact.message, /Senior Consultant/);
  assert.match(contact.message, /Juris Prime Legal/);

  // The employee's declared number is returned for display only — the link
  // opens whatever account is signed in on their device, which the platform
  // cannot control.
  assert.equal(contact.sendingAs, "971501234567");
});

test("the pre-filled text survives the round trip through the URL", () => {
  // An em dash and an apostrophe in the copy; a naive concatenation would
  // produce a link that opens with a mangled or truncated message.
  const contact = buildDirectContact({
    employee: IVAN,
    businessName: "SFS International",
    customerWaId: "+971 50 000 0002",
    customerName: null,
  });

  const decoded = decodeURIComponent(new URL(contact.url).searchParams.get("text"));
  assert.equal(decoded, contact.message);
  assert.match(contact.message, /^Hello — /, "no name available, so no empty greeting");
});

test("an employee with no WhatsApp number still gets a working link", () => {
  // Their own number is a declaration used for display, not something the link
  // depends on. Missing it must not block them from reaching a customer.
  const contact = buildDirectContact({
    employee: { fullName: "Noor", jobTitle: null, whatsappNumber: null },
    businessName: "Zipicka",
    customerWaId: "971500000002",
  });

  assert.ok(contact.url.includes("wa.me/971500000002"));
  assert.equal(contact.sendingAs, null);
  assert.ok(!contact.message.includes("()"), "a missing job title must not leave empty brackets");
});

test("an unreachable customer id produces no link at all", () => {
  const contact = buildDirectContact({
    employee: IVAN,
    businessName: "Zipicka",
    customerWaId: "not-a-number",
  });
  assert.equal(contact, null);
  console.log("PASS: employees reach assigned customers from their own WhatsApp, no extra WABA number");
});
