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
import { ContactButton, ClosingBand, floatVisible, closeReached, watchFloat, NavMenu, FloatingContact } from "@/app/landing-contact";
import { placeNode } from "@/lib/plate";
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
    // Before ANY way onward (5 Nov 2026): the staff sign-in may now go straight
    // back to the screen whose sign-in had ended, by a full navigation.
    const source = read(f);
    const forget = source.indexOf("forgetSystemTheme();");
    const onward = source.slice(forget).search(/router\.|window\.location\.assign\(/);
    assert.ok(forget > 0 && onward > 0 && onward < 400, f);
    assert.doesNotMatch(source.slice(source.indexOf("async function onSubmit"), forget), /router\.(push|refresh|replace)|window\.location\.assign\(/, f);
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

// Phones: the links fold into a menu, and a WhatsApp pill follows the reader (spec §3).
test("the floating pill shows only between the headline and the closing band", () => {
  assert.equal(floatVisible(true, false), false);
  assert.equal(floatVisible(false, false), true);
  assert.equal(floatVisible(false, true), false);
});

test("the phone menu is a real button with its list, closed at first", () => {
  const html = render(NavMenu, { links: [{ href: "#tour", label: "Product" }] });
  assert.match(html, /<button type="button"[^>]*aria-expanded="false"[^>]*aria-controls="lp-menu"/);
  assert.match(html, /<ul id="lp-menu"[^>]*hidden=""/);
  assert.match(html, /<a href="#tour">Product<\/a>/);
  assert.match(read("app/landing-contact.tsx"), /"Escape"/);
});

test("no IntersectionObserver, no pill — and nothing breaks", () => {
  assert.equal(render(FloatingContact, { contact: salesContact("971501234567") }), "");
  assert.match(read("app/landing-contact.tsx"), /typeof IntersectionObserver === "undefined"/);
  assert.match(read("app/landing.tsx"), /<header className="lp-hero" id="top">/);
});

test("the phone's top bar says WhatsApp in one word", () => {
  const html = render(ContactButton, { contact: salesContact("971501234567"), whatsappLabel: "Chat on WhatsApp", shortLabel: "WhatsApp" });
  assert.match(html, /<span class="lp-contact-long">Chat on WhatsApp<\/span><span class="lp-contact-short">WhatsApp<\/span>/);
  assert.match(read("app/landing.tsx"), /whatsappLabel="Chat on WhatsApp" shortLabel="WhatsApp"/);
});

test("on a phone the links fold away and taps are big enough", () => {
  const css = read("app/landing.css");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(phone, /min-height: 44px/);
  assert.match(phone, /env\(safe-area-inset-bottom\)/);
});

// The admin entrance in two parts (spec §3).
test("the admin entrance is two parts, its sign-in untouched", () => {
  const A = read("app/admin/page.tsx");
  assert.match(A, /<aside className="admin-side" aria-hidden="true">/);
  assert.match(A, /<h1>Administrator sign-in<\/h1>/);
  assert.match(A, /mode: "admin"/);
  assert.match(A, /<ThemeToggle compact \/>/);
  for (const tone of ["mustard", "forest", "terra"]) assert.match(A, new RegExp(`admin-tile ${tone}`));
  // Behaviour unchanged: the fields, the button rule, the error wording, the way back.
  assert.match(A, /id="admin-email"/);
  assert.match(A, /id="admin-password"/);
  assert.match(A, /disabled=\{busy \|\| !email\.trim\(\) \|\| !password\}/);
  assert.match(A, /That email and password don't match\./);
  assert.match(A, /<a className="admin-back" href="\/#signin">\s*Staff sign-in\s*<\/a>/);
  const css = read("app/admin/admin.css");
  assert.doesNotMatch(css, /--btn-grad|--sky/);
  assert.doesNotMatch(css, /rgba\(\s*(94, 196, 255|43, 156, 240|63, 178, 255|143, 211, 255)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.admin-shell \{[^}]*flex-direction: column/);
});

// Found in the browser check (Task 7).
test("the top bar follows the scroll: the page clips sideways without becoming a scroll box", () => {
  const css = read("app/landing.css");
  const block = css.slice(css.indexOf(".deck-root.lp {"), css.indexOf("}", css.indexOf(".deck-root.lp {")));
  // overflow-x: hidden made the page root its own scroll container, so the
  // sticky top bar stuck inside a box that never scrolls.
  assert.match(block, /overflow-x: clip;/);
  assert.doesNotMatch(block, /overflow-x: hidden/);
  assert.match(css, /\.lp-nav \{[^}]*position: sticky/);
});

test("on a phone every switchboard card stays inside the plate", () => {
  const angles = [-90, -18, 54, 126, 198];
  for (const [bw, bh, cardW] of [[343, 520, 116], [343, 520, 150], [700, 440, 150]]) {
    for (const ang of angles) {
      const { x } = placeNode(ang, bw, bh, cardW);
      assert.ok(x - cardW / 2 >= 8, `${bw}px, ${ang}°: left edge ${x - cardW / 2}`);
      assert.ok(x + cardW / 2 <= bw - 8, `${bw}px, ${ang}°: right edge ${x + cardW / 2}`);
    }
  }
  // A wide plate keeps its ring exactly as it was drawn.
  const wide = placeNode(-18, 1180, 440, 150);
  const R = 440 * 0.36;
  assert.equal(wide.x, 590 + Math.cos((-18 * Math.PI) / 180) * R * 1.2);
  assert.equal(wide.y, 220 + Math.sin((-18 * Math.PI) / 180) * R);
  assert.match(read("app/landing.tsx"), /placeNode\(meta\.ang, bw, bh, /);
});

test("the floating pill stays away once the closing band is reached, not just while it shows", () => {
  assert.equal(closeReached({ isIntersecting: true, boundingClientRect: { top: 200 } }), true);
  assert.equal(closeReached({ isIntersecting: false, boundingClientRect: { top: -900 } }), true);
  assert.equal(closeReached({ isIntersecting: false, boundingClientRect: { top: 1400 } }), false);
});

test("a jump straight past the closing band (the menu's Sign in) still puts the pill away", () => {
  let fire;
  class FakeObserver {
    constructor(cb) { fire = cb; }
    observe() {}
    disconnect() {}
  }
  const hero = { id: "top" }, talk = { id: "talk" }, signin = { id: "signin" }, foot = { id: "foot" };
  const shown = [];
  watchFloat(hero, [talk, signin, foot], (v) => shown.push(v), FakeObserver);
  const at = (target, isIntersecting, top) => ({ target, isIntersecting, boundingClientRect: { top } });
  // First report: the headline in view, everything after the band below it.
  fire([at(hero, true, 0), at(talk, false, 3000), at(signin, false, 3600), at(foot, false, 4400)]);
  // Scrolled down the page: the headline leaves.
  fire([at(hero, false, -900)]);
  // The menu's Sign in jumps past the band: only the sign-in and the footer report.
  fire([at(signin, true, 80), at(foot, true, 600)]);
  assert.deepEqual(shown, [false, true, false]);
});

// Found by the final review.
test("a local or garbled number falls back to email rather than a broken WhatsApp link", () => {
  // The country is unknown in a local number, so there is no right wa.me link to make.
  for (const raw of ["050 123 4567", "0501234567"]) assert.equal(salesContact(raw).kind, "email", raw);
  assert.equal(salesContact("+971 (0)50 123 4567").href.split("?")[0], "https://wa.me/971501234567");
  assert.equal(salesContact("+00971501234567").href.split("?")[0], "https://wa.me/971501234567");
});

test("the sales number reaches the web container on the deploy path", () => {
  const compose = read("../../docker-compose.prod.yml");
  const web = compose.slice(compose.indexOf("\n  web:"), compose.indexOf("\n  caddy:"));
  assert.match(web, /NEXUS_SALES_WHATSAPP: \$\{NEXUS_SALES_WHATSAPP:-\}/);
  assert.match(read("../../.env.example"), /^NEXUS_SALES_WHATSAPP=$/m);
});

test("from a tablet down, the section links fold into Menu so the top bar keeps one line", () => {
  const css = read("app/landing.css");
  const tablet = [...css.matchAll(/@media \(max-width: 1080px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  assert.match(tablet, /\.lp-nav-links,\s*\.lp-link-quiet \{ display: none; \}/);
  assert.match(tablet, /\.lp-menu \{ display: block;/);
});

test("on a phone the brand is a full-size tap, and on the smallest it gives up its word for Menu", () => {
  const css = read("app/landing.css");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.lp-brand \{[^}]*min-height: 44px/);
  // Only under 360 px — a 375 px phone keeps the word — and only the word: the
  // mark is a span too, and must stay.
  const tiny = css.slice(css.indexOf("@media (max-width: 359px)"));
  assert.ok(css.includes("@media (max-width: 359px)"));
  assert.doesNotMatch(css, /@media \(max-width: 380px\)/);
  // Hidden from the eye only: the link keeps "Nexus Agentic OS" as its name.
  assert.match(tiny, /\.lp-brand > span:not\(\.lp-mark\) \{[^}]*clip: rect\(0 0 0 0\)/);
});
