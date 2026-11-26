/**
 * Staff-first compact Nexus, piece 5 (26 Nov 2026): Customers, My clients, Knowledge and Answer
 * rules. Staff open their own business (four pages asked the server for Zipicka's and were refused
 * for everyone but Zipicka's staff); the list comes first and forms wait behind a button; a phone
 * fits more and scrolls sideways never.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-pages-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as tabs from "@/lib/business-tabs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = (name) => read(`app/deck/${name}/page.tsx`);

// ---- Task 1: staff open their own business ---------------------------------------------------------

test("pageBusinessFor: wait until known; staff their own; an admin their choice", () => {
  const { pageBusinessFor } = tabs;
  assert.equal(typeof pageBusinessFor, "function", "lib/business-tabs exports no pageBusinessFor");
  const staff = { known: true, isOperator: false, mySlug: "sfs-international" };
  const admin = { known: true, isOperator: true, mySlug: null };
  assert.deepEqual(pageBusinessFor({ known: false, isOperator: false, mySlug: null }, null, "zipicka"), {
    business: "zipicka",
    ready: false,
  });
  assert.deepEqual(pageBusinessFor(staff, null, "zipicka"), { business: "sfs-international", ready: true });
  // Staff can never switch, whatever was chosen.
  assert.deepEqual(pageBusinessFor(staff, "abr", "zipicka"), { business: "sfs-international", ready: true });
  assert.deepEqual(pageBusinessFor(admin, null, "zipicka"), { business: "zipicka", ready: true });
  assert.deepEqual(pageBusinessFor(admin, "abr", "zipicka"), { business: "abr", ready: true });
  // Who is asking could not be read (fails closed: employee, no business) — ask anyway, so the
  // server's own reason and Try again show, rather than an outline that never ends.
  assert.deepEqual(pageBusinessFor({ known: true, isOperator: false, mySlug: null }, null, "zipicka"), {
    business: "zipicka",
    ready: true,
  });
});

test("Customers, Knowledge, Answer rules and Forecast wait to know who is asking, then load theirs", () => {
  for (const name of ["customers", "knowledge", "procedures", "forecast"]) {
    const P = page(name);
    assert.match(P, /usePageBusiness\(/, `${name} does not use usePageBusiness`);
    assert.doesNotMatch(P, /useState<BusinessSlug>\(/, `${name} still starts on a fixed business`);
    assert.match(P, /useEffect\(\(\) => \{\n    if \(!ready\) return;/, `${name} loads before it knows whose business`);
  }
  assert.match(page("procedures"), /\{ready \? <PhrasesSection business=\{business\} \/> : null\}/);
  assert.match(page("customers"), /\{ready \? \(\s*<ImportCustomers/);
});

// ---- Task 2: Knowledge and Answer rules — list first, forms folded, slim counters ------------------

/** The source between `<AddFold label="LABEL"` and its `</AddFold>`. */
function fold(P, label) {
  const start = P.indexOf(`<AddFold label="${label}"`);
  assert.ok(start >= 0, `no <AddFold label="${label}"`);
  return P.slice(start, P.indexOf("</AddFold>", start));
}

test("Knowledge: Teach it something waits behind a button; ?add=1 opens it; a save closes it", () => {
  const P = page("knowledge");
  assert.match(fold(P, "Teach it something"), /<form onSubmit=\{handleAdd\}>/);
  assert.match(P, /<AddFold label="Teach it something" open=\{adding\} onOpenChange=\{setAdding\}>/);
  assert.match(P, /get\("add"\) === "1"\) setAdding\(true\)/);
  assert.match(P, /await load\(business\);\n(\s*\/\/[^\n]*\n)*\s*setAdding\(false\);/, "a successful add does not fold the form");
  assert.ok(P.indexOf("<AddFold") < P.indexOf('className="kn-list"'), "the fold button sits above the list");
});

test("Knowledge on a phone: Remove beside the title, the facts on one line under it", () => {
  const css = read("app/deck/knowledge/knowledge.css");
  const phone = css.slice(css.indexOf("@media (max-width: 620px)"));
  assert.match(phone, /\.kn-item \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(phone, /\.kn-remove \{[^}]*grid-column: 2;[^}]*grid-row: 1;/);
  assert.match(phone, /\.kn-meta \{[^}]*grid-column: 1 \/ -1;[^}]*flex-direction: row;/);
});

// ---- Task 3: My clients — ⓘ header, the book first, phone rows -------------------------------------

test("My clients: the ⓘ header, and the book before the set-up panels", () => {
  const P = page("my-clients");
  assert.match(P, /<PageHead\s+title="My clients"\s+about=/);
  assert.doesNotMatch(P, /<header className="mc-head">\s*<h1>My clients<\/h1>\s*<p>/, "the long header is still there");
  assert.ok(P.indexOf('<section className="mc-book">') < P.indexOf("<MyLinkPanel />"), "the book comes after the panels");
  assert.ok(P.indexOf('<section className="mc-book">') < P.indexOf("<ChannelPanel channel={channel} />"));
  assert.match(P, /import "\.\.\/activity\/activity\.css";/, "PageHead's styles are not imported");
  // The page's margins came from `.deck-root:has(> .mc-head)`; without that header it sits in
  // .act-root like every other page (found in the preview: the title touched the screen's edge).
  assert.equal((P.match(/<div className="act-root">/g) ?? []).length, 2, "both of the page's returns sit in .act-root");
  assert.match(P, /clients === null \? \(\s*<PageLoading \/>/, "the book still says a bare Loading line");
});

test("My clients on a phone: each client is a row that fits, Hand back on the right", () => {
  const css = read("app/deck/my-clients/my-clients.css");
  const phone = css.slice(css.indexOf("/* My clients on a phone"));
  assert.match(phone, /@media \(max-width: 640px\)/);
  assert.match(phone, /\.deck-root \.mc-table thead \{[^}]*clip: rect\(0 0 0 0\);/, "headers dropped rather than hidden from sight only");
  assert.match(phone, /\.deck-root \.mc-table tr \{[^}]*display: block;[^}]*position: relative;/);
  assert.match(phone, /\.deck-root \.mc-table td:last-child \{[^}]*position: absolute;/);
});

// ---- Task 4: Customers — denser cards ---------------------------------------------------------------

test("Customers: the badge sits beside the name, number and facts; tighter cards", () => {
  const css = read("app/deck/customers/customers.css");
  const dense = css.slice(css.indexOf("/* Denser (26 Nov 2026"));
  assert.ok(dense.length > 30, "no denser-cards block in customers.css");
  assert.match(dense, /\.cu-cards \{ gap: 8px; \}/);
  assert.match(dense, /\.cu-card \{[^}]*display: grid;[^}]*grid-template-columns: 26px minmax\(0, 1fr\);[^}]*padding: 10px 14px;/);
  assert.match(dense, /\.cu-card-top \{ display: contents; \}/);
  assert.match(dense, /\.cu-card-top \.kit-initials \{[^}]*grid-row: 1 \/ span 3;/);
});

test("Answer rules: Write one yourself waits behind a button; slim counters, hidden under a failed load", () => {
  const P = page("procedures");
  assert.match(fold(P, "Write one yourself"), /<form className="pr-new" onSubmit=\{write\}/);
  assert.match(P, /<AddFold label="Write one yourself" open=\{writing\} onOpenChange=\{setWriting\}>/);
  assert.match(P, /await load\(business\);\n(\s*\/\/[^\n]*\n)*\s*setWriting\(false\);/, "a successful save does not fold the form");
  assert.match(P, /\{loadError \? null : \(\s*<div className="pr-counts">/, "counts drawn under a failed load");
  const css = read("app/deck/procedures/procedures.css");
  assert.match(css, /\.pr-count \{[^}]*border-radius: var\(--r-pill\);/, ".pr-count is not a pill");
  assert.match(css, /\.pr-count strong \{[^}]*font-size: 15px;/, "the counter number is still large");
});
