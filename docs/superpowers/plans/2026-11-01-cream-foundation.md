# Cream Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every signed-in Nexus screen wears the Cream / Warm Night theme, sits in one dark floating sidebar, moves with a shared motion kit and makes small synthesised sounds at key moments.

**Architecture:** Colours change by value in the one token block on `.deck-root` (`app/deck/deck.css`). The operator front page moves into `ConsoleShell`, which becomes the dark dock. Motion is one stylesheet (`app/motion.css`) plus pure helpers (`lib/motion.ts`) started by one client component (`app/motion-boot.tsx`) in the shell; sound is one module (`lib/sound.ts`) with a mute switch. No new packages, no API changes.

**Tech Stack:** Next.js 14 App Router, React 18, plain CSS, View Transitions API, Web Audio API, `node:test` via `apps/web/test/run.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-01-cream-foundation-design.md`

## Global Constraints

- Work in `C:\CLAUDE CODE\nexus-agentic-os` (clone of origin/main at 7468a43). Commit locally; never push — pushing happens only after the owner says "Deploy it".
- No new dependencies in any `package.json`.
- Token NAMES on `.deck-root` do not change; only values (plus the new `--st-*` / `--on-*` status tokens).
- Light values, verbatim: marble `#F3EFE8`, paper `#FFFEFB`, pebble `#ECE6DB`, charcoal `#16140F`, charcoal-card `#24211B`, ink `#16140F`, slate `#5B5549`, mist `#6B6357`, hairline `#E6DFD3`, hairline-strong `#D6CDBE`, signal `#16140F`, signal-text `#2F5D50`, sky `#2F5D50`, sky-deep `#24493F`, sky-soft `#E7EFEA`, sky-wash `rgba(47,93,80,.08)`, on-accent `#F3EFE8`, good `#2B6B4A`, warn `#875400`, crit `#B42318`; status mustard `#E8C24A`/on `#16140F`, forest `#2F5D50`/on `#FFFFFF`, terra `#B4532C`/on `#FFFFFF`, ink `#16140F`/on `#F3EFE8`.
- Dark values, verbatim: marble `#14120E`, paper `#1D1A15`, pebble `#27231C`, charcoal `#0D0C09`, ink `#F3EFE8`, slate `#C9C1B3`, mist `#A69E90`, signal-text `#8CC4AE`, status mustard `#EBC75A`, forest `#6FA892`, terra `#E0835A` (all `--on-*` = `#14120E`), good `#7CC79E`, warn `#E9B65C`, crit `#FF8A7A`.
- Shape: `--r` 22px, `--r-lg` 28px, `--r-sm` 12px. Shadow: `rgba(60,45,20,.05) 0 1px 2px, rgba(60,45,20,.07) 0 14px 30px -14px`.
- Storage keys: `nexus-rail` (`"full"|"icons"`, localStorage), `nexus-rail-from` (href, sessionStorage), `nexus-sound` (`"on"|"off"`, localStorage).
- Every animation and motion transition lives inside `@media (prefers-reduced-motion: no-preference)`.
- Sound master volume 0.22; sound is on by default.
- Out of scope: `.deck-root.lp` (landing), `.admin-root`, `.pl-root`, `app/links`, privacy/terms/data-deletion.

## Review Focus

- **Storage that throws** (private mode, blocked site data): theme, rail and sound boot must not throw and the page must render in its defaults — pinned in Tasks 3 and 6.
- **A browser with no Web Audio** (old Safari, locked-down kiosk): `play` is silent and never throws — pinned in Task 3.
- **Numbers that are not numbers** (`—`, `12.5k`, `$1,014,640`, `45%`): count-up must leave `—` alone and keep prefix/suffix/separators — pinned in Task 4.
- **The phone bar** (≤860px): the dock must not cover the page's last row or the iOS home indicator — checked in Task 8's phone screenshots; the bar keeps `env(safe-area-inset-bottom)` from today's rule.
- **Firefox** (no cross-document view transitions): pages load normally, cards still rise in — checked in Task 8 by loading with `@view-transition` unsupported (CSS simply ignored).

---

### Task 1: Cream and Warm Night tokens

**Files:**
- Modify: `apps/web/app/deck/deck.css` (light token block at the top `.deck-root {`, the dark block `html[data-theme="dark"] .deck-root:not(.lp):not(.admin-root):not(.pl-root)` near line 1067)
- Modify: `apps/web/app/landing.css` (`.deck-root.lp` block, line 11)
- Modify: `apps/web/app/layout.tsx:35` (`themeColor`)
- Test: `apps/web/test/the-cream-theme-reads.test.mjs`

**Interfaces:**
- Produces: tokens `--st-mustard --on-mustard --st-forest --on-forest --st-terra --on-terra --st-ink --on-ink` on `.deck-root`, used by Tasks 2, 5, 6 and part 2.

- [ ] **Step 1: Write the failing test** — reads `deck.css`, extracts the first `.deck-root {…}` block and the dark block, parses `--name: value;` pairs, and asserts:
  - every light and dark value listed in Global Constraints, exactly (case-insensitive);
  - WCAG contrast ≥ 4.5 for: ink/marble, ink/paper, slate/pebble, mist/pebble, signal-text/pebble, on-accent/signal, crit/pebble, good/pebble, warn/pebble, and each `--on-x`/`--st-x` pair — in both themes (dark inherits a light value it does not override);
  - `.deck-root.lp` in `landing.css` pins the Calm values `--marble: #f6f7f9`, `--paper: #ffffff`, `--ink: #111827`, `--signal: #1d4ed8`, `--sky: #3b82f6` so the storefront is unchanged;
  - `layout.tsx` has `themeColor: "#16140F"`;
  - `deck.css` sets `.deck-root .page-head h1` (and the shell's page `h1`) to `font-size: clamp(30px, 3.2vw, 44px)` with `letter-spacing: -0.025em` and `line-height: 1.02`.
  Contrast helper (relative luminance, sRGB) inline in the test file.
- [ ] **Step 2: Run it** — `cd apps/web && node --import tsx --test test/the-cream-theme-reads.test.mjs` → FAIL on the first light value.
- [ ] **Step 3: Change the values** in both blocks, add the eight status tokens to both, set shape and `--lift`/`--lift-sm` to the warm shadow, set the page-title type (weight 700, tabular figures on `.stat .v`), give `.deck-root` a background of `radial-gradient(1200px 600px at 85% -10%, rgba(232,194,74,.10), transparent 60%), var(--marble)`; pin the Calm values on `.deck-root.lp` (copy today's light values for every token the landing page reads); set `themeColor`.
- [ ] **Step 4: Run it** → PASS. Run `npm test` in `apps/web` → all green.
- [ ] **Step 5: Commit** — `git commit -m "Theme: Cream and Warm Night tokens"`

### Task 2: Colours that bypassed the tokens

**Files:**
- Modify: `apps/web/app/inbox/inbox.css`, `apps/web/app/assistant.css`, `apps/web/app/command-palette.css`, `apps/web/app/console-shell.css`, `apps/web/app/deck/my-clients/my-clients.css`, `apps/web/app/deck/links/links.css`, `apps/web/app/deck/team/team.css`, and the three `rgba(59,130,246…)`/`rgba(37,99,235…)` literals in `apps/web/app/deck/deck.css` outside the token blocks
- Test: `apps/web/test/no-calm-blue-left.test.mjs`

- [ ] **Step 1: Write the failing test** — for each file above, assert no match of `/#(3b82f6|2563eb|1d4ed8|1e3a8a|0873c9|eef2fb|93b4ff)\b/i` and no match of `/rgba?\(\s*(59|37|29)\s*,\s*(130|99|78)\s*,\s*(246|235|216)/`. For `deck.css`, run the check on the file with both token blocks removed.
- [ ] **Step 2: Run it** → FAIL listing the files.
- [ ] **Step 3: Replace each literal with the token that names its job** (`var(--signal)`, `var(--sky)`, `var(--sky-wash)`, `var(--sky-soft)`, `var(--signal-text)`, or `color-mix(in srgb, var(--sky) N%, transparent)` for a translucent one). Non-blue literals (white, black overlays) stay.
- [ ] **Step 4: Run it** → PASS; `npm test` green.
- [ ] **Step 5: Commit** — `git commit -m "Theme: screens read their colours from the tokens"`

### Task 3: Sound kit

**Files:**
- Create: `apps/web/lib/sound.ts`, `apps/web/app/sound-toggle.tsx`
- Modify: `apps/web/app/console-shell.css` (`.nx-sound` switch styles, same footprint as the compact theme switch)
- Test: `apps/web/test/sound-stays-polite.test.mjs`

**Interfaces:**
- Produces (`lib/sound.ts`):
  - `export type SoundName = "whoosh" | "pop" | "tick" | "chime" | "ping";`
  - `export const SOUND_KEY = "nexus-sound";`
  - `export function isMuted(): boolean` — `localStorage[SOUND_KEY] === "off"`; storage that throws → `false`.
  - `export function setMuted(muted: boolean): void` — writes the key; swallows storage errors.
  - `export function play(name: SoundName, opts?: { close?: boolean }): void` — returns at once when muted or when neither `AudioContext` nor `webkitAudioContext` exists; one lazily created shared context (resumed if suspended); master gain 0.22; whole body in try/catch.
  - `export function installSoundBridge(target?: EventTarget): () => void` — listens for `nexus:sound` (`detail: SoundName`) and calls `play`; returns the remover.
- Produces (`app/sound-toggle.tsx`): `export function SoundToggle()` — `<button role="switch" aria-checked={!muted} className="nx-sound">`, label "Sound on — mute" / "Sound off — turn on"; reads `isMuted()` in an effect (server renders "on"); after turning on it plays `tick`.

- [ ] **Step 1: Write the failing test** — with `globalThis.localStorage` stubbed per test:
  - `play("chime")` with no `AudioContext` defined does not throw;
  - with a stub `AudioContext` that counts constructions: muted (`"off"`) → 0 constructions; unmuted → exactly 1 across two `play` calls;
  - `isMuted()` is `false` when `localStorage.getItem` throws; `setMuted(true)` does not throw when `setItem` throws;
  - `installSoundBridge(target)` → dispatching `new CustomEvent("nexus:sound", { detail: "tick" })` on `target` constructs the context; calling the returned remover stops it.
- [ ] **Step 2: Run it** → FAIL (module missing).
- [ ] **Step 3: Implement `lib/sound.ts`** — voices (all through the master gain, all ≤ 0.3s except whoosh 0.18s): `whoosh` = white-noise buffer through a bandpass sweeping 400→2400 Hz; `pop` = sine 520→880 Hz in 70ms (reversed when `close`); `tick` = 30ms square at 1800 Hz, gain 0.15; `chime` = sine 660 Hz then 990 Hz, 120ms apart, 250ms decay; `ping` = sine 1320 Hz, 300ms exponential decay. Then `SoundToggle`.
- [ ] **Step 4: Run it** → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** — `git commit -m "Sound: small synthesised sounds with a mute switch"`

### Task 4: Motion kit

**Files:**
- Create: `apps/web/app/motion.css`, `apps/web/lib/motion.ts`, `apps/web/app/motion-boot.tsx`, `apps/web/lib/rail.ts` (constants only: `export const RAIL_KEY = "nexus-rail"; export const RAIL_FROM_KEY = "nexus-rail-from";`)
- Modify: `apps/web/app/console-shell.tsx` (import `./motion.css`, mount `<MotionBoot />` once)
- Test: `apps/web/test/motion-respects-reduced-motion.test.mjs`

**Interfaces:**
- Consumes: `play`, `installSoundBridge` from Task 3.
- Produces (`lib/motion.ts`):
  - `export interface CountParts { prefix: string; value: number; decimals: number; suffix: string; grouped: boolean }`
  - `export function parseCount(text: string): CountParts | null`
  - `export function formatCount(parts: CountParts, value: number): string`
  - `export function countUp(el: HTMLElement, ms?: number): void` (default 700, ease-out, ends on the exact original text)
  - `export function staggerIndex(root: ParentNode, selector: string, cap?: number): void` (default 12; sets `--i` 0…cap-1 on the first matches)
  - `export function setPopOrigin(x: number, y: number): void` (sets `--nx-ox`/`--nx-oy` in px on `document.documentElement`)
- Produces (`app/motion.css`) classes: `.nx-rise` (entrance, delay `calc(var(--i) * 45ms)`), `.nx-draw`, `.nx-grow`, `.nx-pop`, `.nx-pop-backdrop`, `.nx-sheet`, `.nx-sheet-backdrop`; view-transition rules (`@view-transition { navigation: auto; }`, `.shell-rail { view-transition-name: nx-rail; }`, `.shell-main { view-transition-name: nx-page; }` fading/lifting 8px, 140ms out / 260ms in); hover lift on `.card, .glass, .panel` (translateY(-2px), `--lift`); `button:active` scale(.97).
- Produces (`app/motion-boot.tsx`): `export function MotionBoot()` returning `null`. On mount: `staggerIndex(document.querySelector(".shell-main"), ".shell-main > * , .shell-main .card, .shell-main .stat, .shell-main .glass")` and adds `nx-rise` to those; an `IntersectionObserver` calling `countUp` once per `[data-countup]`; a capturing `pointerdown` listener calling `setPopOrigin(e.clientX, e.clientY)`; `installSoundBridge()`; a `click` listener on `.shell-rail a[href]` that writes the current page's `a.on` href to `sessionStorage[RAIL_FROM_KEY]` (guarded) and plays `whoosh`; a `MutationObserver` on `document.body` (childList, subtree) that plays `pop` when a `.nx-pop` or `.nx-sheet` element is added and `pop` with `{ close: true }` when one is removed. Cleans all of these up on unmount.

- [ ] **Step 1: Write the failing test**:
  - `parseCount("$1,014,640")` → `{ prefix: "$", value: 1014640, decimals: 0, suffix: "", grouped: true }`; `parseCount("12.5")` → decimals 1; `parseCount("45%")` → suffix `"%"`; `parseCount("—")` and `parseCount("")` → `null`;
  - `formatCount(parseCount("$1,014,640"), 1014640) === "$1,014,640"` and `formatCount(parseCount("12.5"), 3) === "3.0"`;
  - `motion.css`: after removing every `@media (prefers-reduced-motion: no-preference) {…}` block (brace-matched), the remaining text has no `animation:`, `animation-name:` or `transition:` declarations (`@keyframes` definitions may stay outside); the file contains `@view-transition` and `view-transition-name: nx-rail`;
  - `console-shell.tsx` imports `./motion.css` and renders `<MotionBoot />`.
- [ ] **Step 2: Run it** → FAIL.
- [ ] **Step 3: Implement** `lib/motion.ts`, `motion.css`, `motion-boot.tsx`; mount in the shell.
- [ ] **Step 4: Run it** → PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 5: Commit** — `git commit -m "Motion: page change, rising cards, count-up, draw, zoom and slide"`

### Task 5: The operator front page joins the shell

**Files:**
- Modify: `apps/web/app/page.tsx` (operator branch), `apps/web/app/deck-console.tsx`, `apps/web/app/console-shell.tsx`, `apps/web/app/console-shell.css`, `apps/web/app/deck/layout.tsx`, `apps/web/app/inbox/layout.tsx`
- Test: `apps/web/test/every-signed-in-screen-has-the-sidebar.test.mjs`

**Interfaces:**
- Produces: `ConsoleShell` props become `{ children; role: "operator" | "employee"; me?: {...} | null; signedInAs?: string }`. For `role === "operator"` it renders `<header className="shell-top">` inside `<main className="shell-main">`, above `ViewAsStaff`, holding `<WorkMenu />`, `<NotificationsMenu />`, `<AccountMenu signedInAs={signedInAs ?? ""} />`.

- [ ] **Step 1: Write the failing test** — source assertions:
  - `page.tsx` matches `/<ConsoleShell[^>]*role="operator"[^>]*signedInAs=\{session\.sub\}[\s\S]*<DeckConsole/`;
  - `deck-console.tsx` does not match `/className="topbar"|<nav className="rail"|initDeckFx|<CommandPalette|className="bg"|cur-dot/` and still contains `className="main"` inside an element with class `app`;
  - `console-shell.tsx` renders `WorkMenu`, `NotificationsMenu`, `AccountMenu` only inside a `role === "operator"` branch, and declares `signedInAs?: string`;
  - `deck/layout.tsx` and `inbox/layout.tsx` pass `signedInAs={session?.sub`;
  - `console-shell.css` contains `.deck-root.shell .app` with `display: block`.
- [ ] **Step 2: Run it** → FAIL.
- [ ] **Step 3: Implement** — page.tsx wraps `<DeckConsole signedInAs={session.sub} />` in the shell; DeckConsole keeps its data, page head, quick actions, stats, cards and feed, keeps `<div className="app"><main className="main">…`, and drops the topbar, rail, canvas/grid-overlay/vignette, cursor elements, `initDeckFx` effect and `CommandPalette` mount (delete `lib/deck-fx.ts` if nothing else imports it); shell gains the top bar; CSS resets `.deck-root.shell .app { display: block; min-height: 0; }` and `.deck-root.shell .app > .main { overflow: visible; }` and styles `.shell-top` (flex, end-aligned, gap 8px, padding 14px 26px 0).
- [ ] **Step 4: Run it** → PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 5: Commit** — `git commit -m "Sidebar: the admin front page sits in the same frame as every screen"`

### Task 6: The dark dock

**Files:**
- Modify: `apps/web/lib/rail.ts` (add `RailMode`, `readRailMode`), `apps/web/lib/theme.ts` (`THEME_BOOT`), `apps/web/app/theme-toggle.tsx` (play `tick` on flip), `apps/web/app/console-shell.tsx`, `apps/web/app/console-shell.css` (replace every historical rail section with one "THE DOCK (Cream, 1 Nov 2026)" section; keep the grid, phone layout and install-banner rules), `apps/web/app/mobile-tabs.css`
- Test: `apps/web/test/the-sidebar-remembers.test.mjs`

**Interfaces:**
- Consumes: `SoundToggle` (Task 3), `play` (Task 3), `ThemeToggle` (existing).
- Consumes: `RAIL_KEY`, `RAIL_FROM_KEY` from `lib/rail.ts` (Task 4).
- Produces (`lib/rail.ts`): `export type RailMode = "full" | "icons"; export function readRailMode(read: () => string | null): RailMode` (anything but `"icons"`, or a throwing `read`, → `"full"`).
- Produces (`console-shell.tsx`): `RailCollapse` button (`className="rail-collapse"`, `aria-pressed`, label "Shrink sidebar"/"Expand sidebar") toggling `document.documentElement.dataset.rail` and `localStorage[RAIL_KEY]`, playing `tick`; `RailPill` — one `<span className="rail-pill" aria-hidden="true">` inside the nav, positioned with `transform: translateY(…)` and `height` from the `a.on` link's offset; on mount it first takes the position of the link whose `href === sessionStorage[RAIL_FROM_KEY]` (if any and motion allowed), then on the next frame the current link's, so the CSS transition (380ms, `--ease-out`) slides it; repositions on resize and on `data-rail` change.
- Rail foot holds: who (name/role), `<ThemeToggle compact />`, `<SoundToggle />`, sign out. The brand row loses `ThemeToggle` and gains `RailCollapse`.

- [ ] **Step 1: Write the failing test**:
  - run `THEME_BOOT` in `node:vm` with a fake `document.documentElement` (`setAttribute` recorder) and `localStorage` returning `"icons"` for `nexus-rail` → `data-rail` set to `"icons"`; returning `null` → not set; `getItem` throwing → no exception and nothing set;
  - `readRailMode(() => "icons") === "icons"`, `readRailMode(() => "x") === "full"`, `readRailMode(() => { throw new Error() }) === "full"`;
  - `console-shell.tsx` contains `rail-pill`, `RAIL_FROM_KEY`, `rail-collapse`, `<SoundToggle`, and `<ThemeToggle compact />` inside the `rail-foot` element;
  - `theme-toggle.tsx` calls `play("tick")`;
  - `console-shell.css` contains `html[data-rail="icons"]` rules and `env(safe-area-inset-bottom)`.
- [ ] **Step 2: Run it** → FAIL.
- [ ] **Step 3: Implement** — dock per spec §2: `--charcoal` panel, radius 24px, `margin: 12px 0 12px 12px`, sticky full height (`calc(100dvh - 24px)`), grid column `248px` (`88px` when `html[data-rail="icons"]`, labels/headings/search label hidden, names as tooltips on `:hover`/`:focus-visible`); items cream at 72%, headings mono caps at 50%; the pill is `--marble` with `--ink` text on the `a.on`; dark theme dock `#0D0C09`. Phone (≤860px): floating bar `left/right/bottom: 12px`, radius 22px, icons only, pill becomes horizontal (use `translateX` and width), `padding-bottom: max(8px, env(safe-area-inset-bottom))`; `.mtabs` takes the same dark bar style.
- [ ] **Step 4: Run it** → PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 5: Commit** — `git commit -m "Sidebar: one dark dock with a sliding pill, shrinkable to icons"`

### Task 7: Screens pick up the motion and sound

**Files:**
- Modify: `apps/web/app/deck-console.tsx` (stat value ~line 476, area line ~line 696, `Spark` path ~line 135), `apps/web/app/my-day.tsx` (the `<dd>` counts), `apps/web/app/command-palette.tsx:174`, `apps/web/app/inbox/shortcuts.tsx:70`, `apps/web/app/inbox/ask-colleague.tsx:69`, `apps/web/app/assistant.tsx:118`, `apps/web/app/deck/bulk/page.tsx:483`, `apps/web/app/assignment-alerts.tsx:70`, `apps/web/app/team-chat-alerts.tsx:71`, and the backdrops of those dialogs in their CSS files
- Test: `apps/web/test/screens-move-and-sound.test.mjs`

**Interfaces:**
- Consumes: `.nx-draw`, `.nx-pop`, `.nx-pop-backdrop`, `.nx-sheet`, `[data-countup]` (Task 4); `play` (Task 3).

- [ ] **Step 1: Write the failing test** — source assertions: `deck-console.tsx` wraps `{s.v}` in an element with `data-countup` and puts `className="nx-draw"` on the area line path and the spark line path; `my-day.tsx` has `data-countup` on its counts; `command-palette.tsx`, `shortcuts.tsx`, `ask-colleague.tsx` dialogs include `nx-pop`; `assistant.tsx`'s `<aside className="as` includes `nx-sheet`; `bulk/page.tsx` calls `play("chime")` in the `ok: true` branch; both alert files call `play("ping")` where a new alert/toast is set.
- [ ] **Step 2: Run it** → FAIL.
- [ ] **Step 3: Add the classes, attributes and calls**; give the existing dialog backdrops the `nx-pop-backdrop` class (blur 8px + dim) and the assistant's open state the `nx-sheet-backdrop`.
- [ ] **Step 4: Run it** → PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 5: Commit** — `git commit -m "Motion and sound reach the front page, My Day, dialogs, assistant, bulk and alerts"`

### Task 8: Look at it, then hand over

**Files:**
- Modify: `C:\CLAUDE CODE\bacora\.claude\launch.json` (add `nexus-web-c`: `npm --prefix "C:/CLAUDE CODE/nexus-agentic-os/apps/web" run dev -- -p 3101`, port 3101)

- [ ] **Step 1: Full checks** — `apps/web`: `npm test` and `npm run typecheck`; `apps/api`: `npm test` and `npm run typecheck`. Expected: all green except the API's known environmental `mirror.sh` test.
- [ ] **Step 2: Start the preview** — `nexus-mock-api` and `nexus-web-c` from launch.json. Mint local dev sessions with `signSession` from `apps/web/lib/auth.ts` (dev default secret, localhost only) for an operator and for an SFS International employee, and set them as the `nexus_session` cookie on `localhost:3101` in the built-in browser.
- [ ] **Step 3: Walk the screens** — operator: `/`, `/inbox`, `/deck/hq`, `/deck/team`, `/deck/customers`, `/deck/bulk`; staff: `/`, `/inbox`, `/deck/my-clients`. Each in light and dark at 1440px and 390px; plus shrunk dock at 1440px. Check: the pill slides between pages, cards rise in, figures count up, ⌘K zooms open, the assistant slides in, no console errors, no text below contrast, the phone bar covers nothing.
- [ ] **Step 4: Fix what the walk finds** — each fix with its own test where it is logic, re-run Step 1.
- [ ] **Step 5: Send the owner the screenshots** and ask whether to deploy. Do not push or deploy without "Deploy it".
