/**
 * What a screen shows in the moment before it has any data.
 *
 * ============================================================
 * WHY THESE EXIST
 * ============================================================
 *
 * Every console change on this platform ships on typecheck, a Next build and
 * source-level tests. Nobody looks at it: the deck is behind a sign-in, and the
 * one person who could look is the owner. So the screens have been verified as
 * COMPILING and never as RENDERING.
 *
 * That gap sits exactly on top of the defect this codebase keeps finding. Half
 * the corrections in this suite are about a screen that cannot tell "nothing to
 * report" from "could not ask" — the notifications bell, the to-do menu, the
 * suppressed-conversations list, the customer picker. Every one of those was
 * asserted by grepping the source for a string, because there was no way to
 * render the component and look at what it actually says.
 *
 * ============================================================
 * WHY SERVER RENDERING IS THE RIGHT TOOL HERE
 * ============================================================
 *
 * `renderToStaticMarkup` does not run effects. That is usually described as a
 * limitation and here it is the whole point: what it produces is precisely the
 * frame BEFORE any fetch has resolved — the state these components have been
 * getting wrong. A test that ran the effects would skip past the moment worth
 * checking.
 *
 * These render real components with real props and assert on the markup. No
 * browser, no sign-in, no server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { BusinessTabs } from "@/lib/business-tabs";
import { AddAppointment } from "@/app/deck/bookings/add-appointment";
import { ImportCustomers } from "@/app/deck/customers/import-customers";

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

// ============================================================
// The business switcher
// ============================================================

test("it names no business until it knows who is asking", () => {
  // THE ONE THAT MATTERS FOR SCOPING. An employee of one business must not see
  // five company names flash past on every page load, and the only way to be
  // sure is to look at the first frame — which is what this is.
  const html = render(BusinessTabs, { value: "", onChange: () => {} });

  for (const name of ["Zipicka", "Juris Prime", "SFS International", "ABR Advocates"]) {
    assert.ok(!html.includes(name), `"${name}" is rendered before the viewer's role is known`);
  }
  assert.ok(!html.includes("All businesses"), "the all-businesses tab appears before the role is known");
});

test("the placeholder holds the row's height rather than collapsing it", () => {
  // A switcher that renders nothing at all makes the page jump when the answer
  // arrives. The empty element is deliberate and carries the class that gives
  // it a height.
  const html = render(BusinessTabs, { value: "", onChange: () => {} });
  assert.match(html, /class="act-tabs bt-waiting"/);
  assert.match(html, /aria-hidden="true"/, "an empty placeholder must not be announced to a screen reader");
});

// ============================================================
// Adding an appointment
// ============================================================

test("the diary form stays shut, and says what it is for", () => {
  // It opens on a click. The closed state is what everybody sees, so it has to
  // explain itself in one line rather than being a bare button.
  const html = render(AddAppointment, {
    business: "juris-prime-legal",
    businessName: "Juris Prime Legal",
    timezone: "Asia/Dubai",
    team: [],
    onCreated: () => {},
  });

  assert.match(html, /Add an appointment/);
  assert.match(html, /phoned, emailed or walked in/, "the closed state does not say who this is for");
  // Nothing is written until it is opened and submitted.
  assert.ok(!html.includes("<form"), "the form should not be mounted before it is opened");
});

// ============================================================
// Importing customers
// ============================================================

test("the importer stays shut too", () => {
  const html = render(ImportCustomers, {
    business: "zipicka",
    businessName: "Zipicka",
    onImported: () => {},
  });

  assert.match(html, /Import a customer list/);
  assert.ok(!html.includes("<textarea"), "the paste box should not be mounted before it is opened");
});

// ============================================================
// The thing all of these have in common
// ============================================================

test("no first frame claims a count it has not been given", () => {
  // The failure this whole suite is about, checked across every component here
  // at once: a screen that renders "0" before asking is a screen that says
  // "none" when it means "not yet".
  const frames = [
    render(BusinessTabs, { value: "", onChange: () => {} }),
    render(AddAppointment, {
      business: "abr",
      businessName: "ABR Advocates",
      timezone: "Asia/Dubai",
      team: [],
      onCreated: () => {},
    }),
    render(ImportCustomers, { business: "abr", businessName: "ABR Advocates", onImported: () => {} }),
  ];

  for (const html of frames) {
    // Bare zeroes standing alone as a rendered value — "0 customers", "0 msgs".
    assert.ok(
      !/>\s*0\s*</.test(html),
      `a first frame renders a literal 0 before any data arrived:\n${html.slice(0, 200)}`
    );
  }
});
