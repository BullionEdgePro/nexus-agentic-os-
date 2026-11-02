# The Storefront in Cream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the public storefront (`app/landing.tsx`) and the admin entrance (`app/admin/page.tsx`) into Cream / Warm Night, turn the storefront towards selling with a WhatsApp-first contact button, and let both follow the visitor's light/dark setting.

**Architecture:** In place — the same sections, animations and sign-in logic, recoloured by dropping the storefront's own Clear Sky tokens so it inherits the console's Cream tokens (`app/deck/deck.css`) and its Warm Night block. A pure `salesContact()` turns the server setting `NEXUS_SALES_WHATSAPP` into a WhatsApp or email link that `app/page.tsx` passes to the landing. A tiny inline boot script on the two public pages applies the visitor's system dark mode before paint when no choice is saved.

**Tech Stack:** Next.js 14 App Router, React 18, plain CSS; node:test + tsx render tests (`renderToStaticMarkup`).

**Spec:** `docs/superpowers/specs/2026-11-02-storefront-cream-design.md`

## Global Constraints

- Only true claims and numbers; the mock-ups (`HeroInbox`, `RoutingPlate`, `TourArt`) stay decorative (`aria-hidden`) — no invented figures.
- Sign-in behaviour unchanged: the storefront form posts `mode: "staff"`, /admin posts `mode: "admin"`; field ids, validation and error wording stay.
- WhatsApp setting `NEXUS_SALES_WHATSAPP`; prefilled text exactly `Hi Nexus, I'd like to see how it works for my business`; fallback label exactly `Email us` to `jurishostinger11@gmail.com` (the address `app/privacy/page.tsx` publishes).
- Copy fixed by the spec: `Chat on WhatsApp` (top bar), `Chat with Nexus on WhatsApp` (headline), `See it work`, `Talk to the agent yourself`, `Staff of a Nexus business?`.
- Theme key stays `nexus-theme`; the console's default (light when no choice) is unchanged; `THEME_BOOT` is unchanged.
- Fonts: only those in `lib/fonts.ts` (headline `var(--font-serif)`, Instrument Serif).
- No Clear Sky blues left in `landing.css` / `admin.css`: no `--sky*`, `--btn-grad`, `--signal-deep`, and no `#3b82f6 #2563eb #1d4ed8 #1e3a8a #93b4ff #eef2fb`.
- Every animation stops under `prefers-reduced-motion: reduce`; text ≥ 4.5:1 in both themes; tap targets ≥ 44 px on phones; no sideways scroll at 375 px.
- Tests: `npm --prefix apps/web test`; API `cd apps/api && npm test` (the Windows-only "mirror.sh is itself executable" failure is known). Commit locally only; never push or deploy without the owner's "Deploy it".

## Review Focus

1. **A sales number typed the human way** (`+971 50 123 4567`, `971-50-1234567`, `00971…`, spaces, an empty value, letters): normalised to digits or, if not 8–15 digits, the email fallback — never a broken `wa.me` link. → Task 1 test.
2. **Storage blocked (private mode, strict settings):** the public boot script and the switch never throw; the page still follows the system setting. → Task 2 test.
3. **A saved choice beats the system:** a visitor who chose light on a dark-mode phone gets light on the storefront, the admin entrance and the console. → Task 2 test.
4. **A browser without IntersectionObserver:** the floating phone pill simply stays hidden; nothing errors. → Task 5 test.
5. **Keyboard on the phone menu:** Enter/Space opens it, Escape closes it and puts focus back on its button, the links are reachable in order. → Task 5 test, plus the browser check.

---

### Task 1: The sales contact link

**Files:**
- Create: `apps/web/lib/sales-contact.ts`, `apps/web/app/landing-contact.tsx`
- Modify: `apps/web/app/page.tsx` (pass `contact`), `apps/web/app/landing.tsx` (accept the prop)
- Test: `apps/web/test/the-storefront-sells.test.mjs` (new)

**Interfaces:**
- Produces: `type SalesContact = { kind: "whatsapp" | "email"; href: string }`; `salesContact(raw: string | undefined): SalesContact`; constants `SALES_TEXT`, `CONTACT_EMAIL`.
- Produces: `ContactButton({ contact, whatsappLabel, className }: { contact: SalesContact; whatsappLabel: string; className?: string })` — an `<a>`; WhatsApp: `whatsappLabel`, `target="_blank" rel="noopener"`, a WhatsApp glyph; email: `Email us`, a mail glyph, no target.
- Produces: `Landing({ contact }: { contact: SalesContact })`.

- [ ] **Step 1: Write the failing tests**

```js
import { salesContact, SALES_TEXT } from "@/lib/sales-contact";
import { ContactButton } from "@/app/landing-contact";

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
```

- [ ] **Step 2: Run** `npm --prefix apps/web test` — Expected: FAIL (`@/lib/sales-contact` not found).
- [ ] **Step 3: Implement.** `salesContact`: trim; remove spaces, hyphens, dots and parentheses; strip one leading `+` or `00`; require `^\d{8,15}$`, else email. Email href `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Nexus for my business")}`. `ContactButton` in `app/landing-contact.tsx` (`"use client"` not needed — no state). `app/page.tsx` passes the prop; `Landing` accepts it (used in Task 4).
- [ ] **Step 4: Run** `npm --prefix apps/web test` and `npx tsc --noEmit -p .` in apps/web — Expected: PASS, clean.
- [ ] **Step 5: Commit** — `"Storefront: the sales contact link, WhatsApp first, email until the number is set"`

---

### Task 2: Light and dark follow the visitor on the public pages

**Files:**
- Modify: `apps/web/lib/theme.ts` (add `PUBLIC_THEME_BOOT`), `apps/web/app/landing.tsx` and `apps/web/app/admin/page.tsx` (render it first), `apps/web/app/deck/deck.css:1068` (the Warm Night selector)
- Modify: the spec's §1 "Following the visitor" bullet (mechanism: boot script, see Ruling)
- Test: `apps/web/test/the-storefront-sells.test.mjs`

**Interfaces:**
- Produces: `PUBLIC_THEME_BOOT: string` — inline, blocking: read the saved `nexus-theme` in its own `try` (blocked storage counts as "nothing saved"); then, in a second `try`, if nothing valid is saved and `matchMedia("(prefers-color-scheme: dark)").matches`, set `data-theme="dark"` on `<html>` WITHOUT saving it.
- Ruling to record: the system default is applied by this script, not a CSS media query — a media query would copy the whole Warm Night token block a second time; the script reuses the one block and still runs before the page paints.

- [ ] **Step 1: Write the failing tests** — run the boot string in `node:vm` with stubs:

```js
import vm from "node:vm";
import { PUBLIC_THEME_BOOT } from "@/lib/theme";
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
```

- [ ] **Step 2: Run** — Expected: FAIL (`PUBLIC_THEME_BOOT` not exported).
- [ ] **Step 3: Implement** the string, render it as the first child of each public root, change the deck.css selector, amend the spec bullet.
- [ ] **Step 4: Run** both suites — Expected: PASS (the console's theme guard tests unchanged).
- [ ] **Step 5: Commit** — `"Storefront and admin follow the visitor's light or dark"`

---

### Task 3: Cream colours, the sunrise and the night sky

**Files:**
- Modify: `apps/web/app/landing.css` (token block and every Clear Sky use), `apps/web/test/the-cream-theme-reads.test.mjs:96-103` (rewrite "keeps its Calm colours until part 3")
- Test: `apps/web/test/the-storefront-sells.test.mjs`

**Interfaces:**
- Produces: in `.deck-root.lp` only storefront tokens, all derived from Cream ones: `--lp-max: 1180px`, `--lp-accent: var(--st-forest)`, `--lp-on-accent: var(--on-forest)`, `--lp-glow-a` (mustard light), `--lp-glow-b` (terracotta light), `--lp-line` (circuit line), `--lp-pulse: var(--st-mustard)`. Their Warm Night values in `html[data-theme="dark"] .deck-root.lp {}`.

- [ ] **Step 1: Write the failing tests**

```js
test("the storefront wears Cream: no colours of its own, no Clear Sky left", () => {
  const css = read("app/landing.css");
  const block = css.slice(css.indexOf(".deck-root.lp {"), css.indexOf("}", css.indexOf(".deck-root.lp {")));
  for (const own of ["--marble:", "--paper:", "--ink:", "--hairline:", "--slate:"]) assert.ok(!block.includes(own), own);
  assert.match(block, /--lp-accent: var\(--st-forest\);/);
  assert.doesNotMatch(css, /--sky|--btn-grad|--signal-deep/);
  assert.doesNotMatch(css, /#(3b82f6|2563eb|1d4ed8|1e3a8a|93b4ff|eef2fb)\b/i);
  assert.match(css, /html\[data-theme="dark"\] \.deck-root\.lp \{/);
  assert.match(css, /\.lp-hero h1 \{[^}]*font-family: var\(--font-serif\)/);
  // Calm when asked: the twinkle and the pulses only move with motion welcome.
  const calm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(calm, /animation: none/);
});
```

Rewrite the old guard in `the-cream-theme-reads.test.mjs` to the same purpose: "the storefront takes the console's Cream tokens" — `.deck-root.lp` defines none of `--marble --paper --ink --signal --sky`.

- [ ] **Step 2: Run** — Expected: FAIL (Clear Sky tokens present).
- [ ] **Step 3: Implement** — delete the Clear Sky base tokens; replace every `--sky*`, `--btn-grad`, `--signal*`, `--charcoal*`, `--*-on-dark` use with Cream tokens or the `--lp-*` set; `.lp-sky` blooms become the light sunrise (`--lp-glow-a/-b`) and, under Warm Night, dim lamplight plus a star field (small radial-gradient dots, a slow twinkle in the motion block); circuit traces `--lp-line`, pulses `--lp-pulse`; cards and buttons as the console's (paper, `--r-lg`, `--lift-sm`, pill buttons; primary `.btn` = `--lp-accent` / `--lp-on-accent`); headline `var(--font-serif)`.
- [ ] **Step 4: Run** both suites — Expected: PASS (custom-property and pure-black guards included).
- [ ] **Step 5: Commit** — `"Storefront in Cream: a sunrise by day, a night sky after dark"`

---

### Task 4: The storefront sells — top bar, headline button, closing band, team card

**Files:**
- Modify: `apps/web/app/landing.tsx` (nav, hero CTA, new closing band, sign-in section heading), `apps/web/app/landing-contact.tsx` (add `ClosingBand`), `apps/web/app/landing.css` (band, team card)
- Test: `apps/web/test/the-storefront-sells.test.mjs`

**Interfaces:**
- Consumes: Task 1's `ContactButton`, `SalesContact`; `ThemeToggle` (`app/theme-toggle.tsx`, `compact`).
- Produces: `ClosingBand({ contact }: { contact: SalesContact })` — `<section className="lp-close" id="talk" aria-labelledby="talk-h">` with `<h2 id="talk-h">Talk to the agent yourself</h2>`, one line (WhatsApp: "The button opens WhatsApp to a number Nexus answers — ask it what a customer would."; email: "Write to us and we'll show you Nexus on your own business."), and `ContactButton whatsappLabel="Chat with Nexus on WhatsApp"`.

- [ ] **Step 1: Write the failing tests**

```js
import { ClosingBand } from "@/app/landing-contact";
test("the closing band asks once more, honestly for each kind of contact", () => {
  const wa = render(ClosingBand, { contact: salesContact("971501234567") });
  assert.match(wa, /Talk to the agent yourself/);
  assert.match(wa, /a number Nexus answers/);
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
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — nav: brand; links; `ThemeToggle compact`; quiet "Sign in" (`href="#signin"`); WhatsApp pill. (The nav's "Admin" link goes; "Administrator sign-in" stays in the team card's hint — record as a ruling.) Hero: `ContactButton` + "See it work". `ClosingBand` before `#signin`. Sign-in section: kicker/heading "Staff of a Nexus business?", compact cream card; the form untouched.
- [ ] **Step 4: Run** both suites and tsc — Expected: PASS, clean.
- [ ] **Step 5: Commit** — `"Storefront sells: WhatsApp in the top bar, the headline and a closing band"`

---

### Task 5: Phones — the folding menu and the floating WhatsApp pill

**Files:**
- Modify: `apps/web/app/landing-contact.tsx` (add `NavMenu`, `FloatingContact`, `floatVisible`), `apps/web/app/landing.tsx`, `apps/web/app/landing.css` (phone block)
- Test: `apps/web/test/the-storefront-sells.test.mjs`

**Interfaces:**
- Produces: `floatVisible(heroInView: boolean, closeInView: boolean): boolean` (`!heroInView && !closeInView`).
- Produces: `NavMenu({ links }: { links: Array<{ href: string; label: string }> })` — `"use client"`; `<button type="button" aria-expanded aria-controls="lp-menu">Menu</button>` + `<ul id="lp-menu">` shown when open; Escape closes and refocuses the button; choosing a link closes.
- Produces: `FloatingContact({ contact }: { contact: SalesContact })` — `"use client"`; watches `#top` (hero) and `#talk` with IntersectionObserver; renders nothing until it has observed, and nothing at all when `typeof IntersectionObserver === "undefined"`.

- [ ] **Step 1: Write the failing tests**

```js
import { floatVisible, NavMenu, FloatingContact } from "@/app/landing-contact";
test("the floating pill shows only between the headline and the closing band", () => {
  assert.equal(floatVisible(true, false), false);
  assert.equal(floatVisible(false, false), true);
  assert.equal(floatVisible(false, true), false);
});
test("the phone menu is a real button with its list, closed at first", () => {
  const html = render(NavMenu, { links: [{ href: "#tour", label: "Product" }] });
  assert.match(html, /<button type="button"[^>]*aria-expanded="false"[^>]*aria-controls="lp-menu"/);
  assert.match(read("app/landing-contact.tsx"), /"Escape"/);
});
test("no IntersectionObserver, no pill — and nothing breaks", () => {
  assert.equal(render(FloatingContact, { contact: salesContact("971501234567") }), "");
  assert.match(read("app/landing-contact.tsx"), /typeof IntersectionObserver === "undefined"/);
});
test("on a phone the links fold away and taps are big enough", () => {
  const css = read("app/landing.css");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.lp-nav-links \{[^}]*display: none/);
  assert.match(phone, /min-height: 44px/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — the hero gets `id="top"`; `NavMenu` and `FloatingContact` mounted in `Landing`; phone CSS: links hidden, menu shown, hero text before the mock-up, switchboard scaled to fit, the pill fixed bottom-centre above the safe area; desktop hides the menu button and the pill.
- [ ] **Step 4: Run** both suites and tsc — Expected: PASS, clean.
- [ ] **Step 5: Commit** — `"Storefront on phones: a folding menu and a WhatsApp pill that follows you"`

---

### Task 6: The admin entrance in two parts

**Files:**
- Modify: `apps/web/app/admin/page.tsx` (side panel, ThemeToggle, boot from Task 2), `apps/web/app/admin/admin.css` (drop the Clear Sky overrides at lines ~127-185; two-part layout; phone stack)
- Test: `apps/web/test/the-storefront-sells.test.mjs`

**Interfaces:**
- Produces: `<aside className="admin-side" aria-hidden="true">` (Nexus mark, "Administrator sign-in" as display text, three glass tiles `admin-tile mustard|forest|terra`) beside the existing `<main className="admin-card">`.

- [ ] **Step 1: Write the failing test**

```js
test("the admin entrance is two parts, its sign-in untouched", () => {
  const A = read("app/admin/page.tsx");
  assert.match(A, /<aside className="admin-side" aria-hidden="true">/);
  assert.match(A, /<h1>Administrator sign-in<\/h1>/);
  assert.match(A, /mode: "admin"/);
  assert.match(A, /<ThemeToggle compact \/>/);
  const css = read("app/admin/admin.css");
  assert.doesNotMatch(css, /--btn-grad|--sky/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.admin-shell \{[^}]*flex-direction: column/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — `admin-shell` (flex row: side panel in the dock's near-black with the tiles, the paper card); phone: column, the side panel a band. Fields, button rules, error wording, "Back to Nexus" unchanged.
- [ ] **Step 4: Run** both suites and tsc — Expected: PASS, clean.
- [ ] **Step 5: Commit** — `"Admin entrance in Cream: a dock-dark panel beside the sign-in"`

---

### Task 7: See it in the browser

Local preview (`.claude/launch.json` `nexus-mock-api` + `nexus-web-c`), signed out (clear the session cookie), at 1280 px and 375 px, Cream and Warm Night (system dark with nothing saved, then the switch):

- [ ] The storefront and /admin: no sideways scroll; a contrast probe over every text element finds nothing under 4.5:1; reduced motion stops the pulses, twinkle and tour.
- [ ] The WhatsApp buttons with `NEXUS_SALES_WHATSAPP` unset (Email us) and set in the dev server's environment (wa.me links, new tab).
- [ ] Keyboard: the top bar, the phone menu (Enter opens, Escape closes and refocuses), the tour tabs, both forms.
- [ ] The floating pill appears after the headline and hides over the closing band.
- [ ] Fix anything found, each with a failing test first; both suites green; commit `"Storefront: fixes from the browser check"`.

## Deploy (after the owner's review and "Deploy it")

Merge `storefront-cream` into main, push, `scripts/deploy.sh` on the VPS. No database change. When the sales number exists: add `NEXUS_SALES_WHATSAPP=<digits>` to the web container's environment and restart it.
