/**
 * The storefront in Cream, part 3 (spec 2026-11-02-storefront-cream-design.md):
 * a product site that wins other businesses, with WhatsApp as the way in and
 * email until the sales number is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import vm from "node:vm";

import { salesContact, SALES_TEXT } from "@/lib/sales-contact";
import { ContactButton, ClosingBand } from "@/app/landing-contact";
import { PUBLIC_THEME_BOOT, forgetSystemTheme } from "@/lib/theme";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test("a sales number becomes a WhatsApp link with the prefilled hello", () => {
  const c = salesContact("971501234567");
  assert.equal(c.kind, "whatsapp");
  assert.equal(c.href, `https://wa.me/971501234567?text=${encodeURIComponent(SALES_TEXT)}`);
  assert.equal(SALES_TEXT, "Hi Nexus, I'd like to see how it works for my business");
});

test("a number typed the human way still works; anything else falls back to email", () => {
  for (const raw of ["+971 50 123 4567", " 971-50-1234567 ", "+971501234567"]) {
    assert.equal(salesContact(raw).href.split("?")[0], "https://wa.me/971501234567", raw);
  }
  assert.equal(salesContact("00971501234567").href.split("?")[0], "https://wa.me/971501234567");
  for (const raw of [undefined, "", "   ", "call us", "12345", "1234567890123456"]) {
    const c = salesContact(raw);
    assert.equal(c.kind, "email", String(raw));
    assert.match(c.href, /^mailto:jurishostinger11@gmail\.com/);
  }
});

test("the button says where it goes", () => {
  const wa = render(ContactButton, { contact: salesContact("971501234567"), whatsappLabel: "Chat on WhatsApp" });
  assert.match(wa, /href="https:\/\/wa\.me\/971501234567\?text=/);
  assert.match(wa, />Chat on WhatsApp</);
  assert.match(wa, /target="_blank"/);
  assert.match(wa, /rel="noopener"/);
  const mail = render(ContactButton, { contact: salesContact(undefined), whatsappLabel: "Chat on WhatsApp" });
  assert.match(mail, />Email us</);
  assert.doesNotMatch(mail, /target=/);
});

test("the storefront reads the number on the server, per request", () => {
  const P = read("app/page.tsx");
  assert.match(P, /export const dynamic = "force-dynamic"/);
  assert.match(P, /<Landing contact=\{salesContact\(process\.env\.NEXUS_SALES_WHATSAPP\)\} \/>/);
});

// Light and dark follow the visitor on the public pages (spec §1).
const runBoot = ({ saved, dark, storageThrows = false }) => {
  const attrs = {};
  const ctx = {
    document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } },
    localStorage: { getItem: () => { if (storageThrows) throw new Error("blocked"); return saved ?? null; } },
    matchMedia: (q) => ({ matches: q.includes("dark") && dark }),
  };
  vm.runInNewContext(PUBLIC_THEME_BOOT, ctx);
  return attrs["data-theme"] ?? null;
};

test("public pages follow the visitor's dark setting when nothing is saved", () => {
  assert.equal(runBoot({ saved: null, dark: true }), "dark");
  assert.equal(runBoot({ saved: null, dark: false }), null);
});

test("a saved choice beats the system; blocked storage still follows the system", () => {
  assert.equal(runBoot({ saved: "light", dark: true }), null);
  assert.equal(runBoot({ storageThrows: true, dark: true }), "dark");
  assert.equal(runBoot({ storageThrows: true, dark: false }), null);
});

test("both public pages boot it, and Warm Night reaches them", () => {
  for (const f of ["app/landing.tsx", "app/admin/page.tsx"]) {
    assert.match(read(f), /<script dangerouslySetInnerHTML=\{\{ __html: PUBLIC_THEME_BOOT \}\} \/>/, f);
  }
  const deck = read("app/deck/deck.css");
  assert.match(deck, /html\[data-theme="dark"\] \.deck-root:not\(\.pl-root\) \{/);
  assert.doesNotMatch(deck, /:not\(\.lp\):not\(\.admin-root\)/);
});

// Signing in is a soft refresh, so the system's dark would follow the visitor
// into the console, whose default with nothing saved is light.
test("signing in hands the console its own default, not the system's", () => {
  const run = (saved) => {
    const removed = [];
    globalThis.document = { documentElement: { removeAttribute: (k) => removed.push(k) } };
    globalThis.localStorage = { getItem: () => saved };
    try {
      forgetSystemTheme();
    } finally {
      delete globalThis.document;
      delete globalThis.localStorage;
    }
    return removed;
  };
  assert.deepEqual(run(null), ["data-theme"]);
  assert.deepEqual(run("dark"), []);
  assert.deepEqual(run("light"), []);
  for (const f of ["app/landing.tsx", "app/admin/page.tsx"]) {
    assert.match(read(f), /forgetSystemTheme\(\);\s*router\./, f);
  }
});

// Cream colours, a sunrise by day and a night sky after dark (spec §1).
test("the storefront wears Cream: no colours of its own, no Clear Sky left", () => {
  const css = read("app/landing.css");
  const block = css.slice(css.indexOf(".deck-root.lp {"), css.indexOf("}", css.indexOf(".deck-root.lp {")));
  for (const own of ["--marble:", "--paper:", "--ink:", "--hairline:", "--slate:"]) assert.ok(!block.includes(own), own);
  assert.match(block, /--lp-accent: var\(--st-forest\);/);
  assert.doesNotMatch(css, /--sky|--btn-grad|--signal-deep/);
  assert.doesNotMatch(css, /#(3b82f6|2563eb|1d4ed8|1e3a8a|93b4ff|eef2fb)\b/i);
  assert.match(css, /html\[data-theme="dark"\] \.deck-root\.lp \{/);
  // The console's own serif token: Instrument Serif, with its fallbacks.
  assert.match(css, /\.lp-hero h1 \{[^}]*font-family: var\(--serif\)/);
  assert.match(read("app/deck/deck.css"), /--serif: var\(--font-serif\), "Instrument Serif"/);
  // Calm when asked: the twinkle and the pulses only move with motion welcome.
  const calm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(calm, /animation: none/);
  assert.match(calm, /\.lp-sky::after/);
});

// The page sells: WhatsApp in the top bar, the headline and a closing band (spec §2).
test("the closing band asks once more, honestly for each kind of contact", () => {
  const wa = render(ClosingBand, { contact: salesContact("971501234567") });
  assert.match(wa, /Talk to the agent yourself/);
  assert.match(wa, /a number Nexus answers/);
  assert.match(wa, /<section class="lp-close" id="talk" aria-labelledby="talk-h">/);
  const mail = render(ClosingBand, { contact: salesContact(undefined) });
  assert.match(mail, /Email us/);
  assert.doesNotMatch(mail, /a number Nexus answers/);
});

test("the storefront's top bar, headline and sign-in are the sales page's", () => {
  const L = read("app/landing.tsx");
  assert.match(L, /<ThemeToggle compact \/>/);
  assert.match(L, /<ContactButton contact=\{contact\} whatsappLabel="Chat on WhatsApp"/);
  assert.match(L, /<ContactButton contact=\{contact\} whatsappLabel="Chat with Nexus on WhatsApp"/);
  assert.match(L, /<ClosingBand contact=\{contact\} \/>/);
  assert.match(L, /Staff of a Nexus business\?/);
  assert.doesNotMatch(L, /Enter the console/);
  // Sign-in unchanged.
  assert.match(L, /mode: "staff"/);
  assert.match(L, /id="email"/);
  assert.match(L, /id="pass"/);
  assert.match(L, /<a href="\/admin">Administrator sign-in<\/a> is separate\./);
});
