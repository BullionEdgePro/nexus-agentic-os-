# Cream foundation — theme, one sidebar, motion and sound

Date: 2026-11-01
Status: approved in conversation (theme, sidebar, motion, sound/tests — all "Looks right")
Part 1 of 3. Part 2 is the dashboard pages (number rows, charts, status cards, boards).
Part 3 is the storefront (the public landing page). Each gets its own spec, plan and deploy.

## Why

The owner shared a 17-second demo of a sales CRM ("rappport", YouTube Short
8N1ae8hMEcs) and asked for its design, theme, motion and sound across Nexus, and
for the sidebar to be the same, complete one on every dashboard.

What the video shows, and what this part takes from it:

| In the video | In Nexus after part 1 |
|---|---|
| Warm cream ground, white rounded cards, soft shadows | The "Cream" theme on every signed-in screen |
| Near-black ink; black pills for the active tab and main buttons | Black pill buttons; the active sidebar item is a pill |
| Mustard / forest / terracotta / black status cards | Four status colours as tokens, each with a passing text colour |
| Two-line titles, very large figures | Bigger, tighter page titles and figures |
| Dark floating dock on the left | The one sidebar: a dark floating dock with names, shrinkable to icons |
| Black pill slides to the new tab | The active pill slides from the last page's item to the new one |
| Page fades, title rises, cards rise in a stagger | Page-change transition and staggered card entrance |
| Numbers count up, lines draw, bars grow | Count-up and draw/grow helpers |
| Card grows into a centred window over a blurred page | Pop-up windows zoom out from the clicked element |
| Invoice slides in from the right over a frosted page | Side panels slide in from the right |
| (audio could not be inspected) | Our own small synthesised sounds at key moments |

What the video shows that is NOT part 1: the screens themselves (revenue chart
tooltip, pipeline board, customer cards, invoice document with PAID stamp,
growth charts). Those are part 2, built with part 1's helpers.

## Decisions (the owner's choices)

1. **Full video look.** Replaces the blue "Calm" theme of 22 Oct 2026 in light
   mode; dark mode becomes a matching "Warm Night".
2. **Dark dock with names.** Icon + name + section headings; a « button shrinks
   it to an icon-only dock; phones get it as a floating bottom bar.
3. **Sound at key moments, on by default, mute switch.**
4. **Browser-native motion, no new library.**

## Scope

In: every signed-in screen — the operator front page (`/`), the staff front
page, `/inbox`, every `/deck/*` page including HQ, the command palette and the
assistant panel.

Out: the landing page (`.deck-root.lp`), public link pages (`app/links`), the
admin sign-in page (`.admin-root`), privacy / terms / data-deletion. These keep
today's look until part 3.

Working copy: the D: drive is unplugged, so the work happens in
`C:\CLAUDE CODE\nexus-agentic-os` cloned from `origin/main` at 7468a43 (the
live build). Commits stay local until the owner says "Deploy it"; then push and
deploy as usual. When D: returns, its checkout is brought up with `git pull`.

## 1. Theme

All colours stay in the one token block on `.deck-root` in
`apps/web/app/deck/deck.css`; this part changes the values, not the names, so
every screen that reads a token changes with it.

### Cream (light)

| Token | Value | Use |
|---|---|---|
| `--marble` | `#F3EFE8` | page ground (plus a faint warm radial glow) |
| `--paper` | `#FFFEFB` | cards, panels |
| `--pebble` | `#ECE6DB` | inset fills, badges, hover washes |
| `--charcoal` / `--charcoal-card` | `#16140F` / `#24211B` | inverse surfaces, the sidebar |
| `--ink` | `#16140F` | text |
| `--slate` | `#5B5549` | secondary text (5.95:1 on pebble) |
| `--mist` | `#6B6357` | tertiary text (4.77:1 on pebble, the worst ground) |
| `--hairline` / `--hairline-strong` | `#E6DFD3` / `#D6CDBE` | lines |
| `--signal` | `#16140F` | primary buttons and the active pill (black) |
| `--signal-text` | `#2F5D50` | links (6.03:1 on pebble) |
| `--sky`, `--sky-deep` | `#2F5D50`, `#24493F` | graphics that used the brand blue |
| `--sky-soft` / `--sky-wash` | `#E7EFEA` / `rgba(47,93,80,.08)` | own chat bubbles, selected rows |
| `--btn-grad` | `linear-gradient(180deg,#24211B,#16140F)` | buttons with words on them |
| `--on-accent` | `#F3EFE8` | text on black buttons |
| `--good` / `--warn` / `--crit` | `#2B6B4A` / `#875400` / `#B42318` | severity (all ≥5.1:1 on pebble) |

New status tokens (stages, business tags, chart series):

| Token | Fill | Text on it |
|---|---|---|
| `--st-mustard` / `--on-mustard` | `#E8C24A` | `#16140F` (10.7:1) |
| `--st-forest` / `--on-forest` | `#2F5D50` | `#FFFFFF` (7.5:1) |
| `--st-terra` / `--on-terra` | `#B4532C` | `#FFFFFF` (5.0:1) |
| `--st-ink` / `--on-ink` | `#16140F` | `#F3EFE8` (16:1) |

Urgent (`--crit`) never relies on colour alone: every crit badge already
carries a word ("Urgent", "Blocked", "Failed"), so crit can never be mistaken
for terracotta.

Shape: `--r` 22px, `--r-lg` 28px, `--r-sm` 12px, buttons and tabs are pills.
Elevation: warm, close shadows, `rgba(60,45,20,.05) 0 1px 2px, rgba(60,45,20,.07) 0 14px 30px -14px`.
Type: Manrope stays. Page titles (`.page-head h1` and each page's `h1`) grow to
clamp(30px, 3.2vw, 44px), weight 700, letter-spacing -0.025em, line-height 1.02.
Large figures use tabular numbers.

### Warm Night (dark)

Same names, under the existing `html[data-theme="dark"] .deck-root:not(.lp):not(.admin-root):not(.pl-root)` block:
ground `#14120E`, paper `#1D1A15`, pebble `#27231C`, ink `#F3EFE8`, slate
`#C9C1B3`, mist `#A69E90` (5.9:1 on pebble), links `#8CC4AE`, sidebar
`#0D0C09`, status fills mustard `#EBC75A`, forest `#6FA892`, terracotta
`#E0835A` (all carry `#14120E` text at ≥6.7:1), severity good `#7CC79E`, warn
`#E9B65C`, crit `#FF8A7A`.

### Files with their own colours

Hard-coded colours are moved onto tokens in: `app/inbox/inbox.css`,
`app/assistant.css`, `app/command-palette.css`, `app/console-shell.css`,
`app/deck/my-clients/my-clients.css`, `app/deck/links/links.css`,
`app/deck/team/team.css`. The landing page keeps the Calm values by pinning them
on `.deck-root.lp` until part 3, so the storefront is never half-changed.

The theme-colour meta (`viewport.themeColor`) becomes `#16140F`.

## 2. One sidebar for everyone

### Every signed-in screen in one frame

`ConsoleShell` (`app/console-shell.tsx`) is already the frame for `/deck/*`,
`/inbox` and the staff front page. The operator front page
(`app/deck-console.tsx`) still builds its own header and rail. It moves inside
the shell: `app/page.tsx` renders `<ConsoleShell role="operator"><DeckConsole/></ConsoleShell>`,
and `DeckConsole` drops its own brand, rail, `CommandPalette` mount, backdrop
canvas, grid overlay, vignette and ink-crosshair cursor (`initDeckFx`). The
video's clean ground has no backdrop and a normal pointer.

Its header tools move into the shell: for operators the shell shows a slim top
bar on every page with `HeaderSearch`, `WorkMenu`, `NotificationsMenu` and
`AccountMenu` (`app/header-menus.tsx`). `HeaderSearch` stays: it searches
customers and conversations through the API, which the dock's ⌘K palette (it
finds screens, and staff's own clients) does not. Staff keep no top bar. The front page
keeps its `.app` / `.main` class names so its existing card styles still
apply; the shell resets `.app` from a grid to a plain block.

### The dock

- A dark panel (`--charcoal`), radius 24px, floating 12px from the left, top and
  bottom edges, full height, sticky. The page column starts 12px after it.
- Brand row: black rounded square with the Nexus hex mark in cream, then
  lowercase "nexus", then the « collapse button.
- Search box (opens the existing ⌘K palette).
- Section headings (`NAV_GROUPS`) in small mono caps at 50% cream (4.8:1).
- Items: icon + name in cream at 72% (8.7:1). Hover: 100% cream on a faint
  cream wash. Current page: a cream pill with black text (16:1) and
  `aria-current="page"`, as today.
- **Sliding pill.** One absolutely-positioned pill element sits behind the
  items. On load it starts at the position of the item the person clicked on
  the previous page (kept in `sessionStorage` under `nexus-rail-from`) and
  slides to the current item in 380ms. No stored position, or reduced motion:
  it is simply placed.
- **Collapse.** « shrinks the dock to 76px, icons only; names appear as a
  tooltip on hover and keyboard focus. The choice is kept in `localStorage`
  under `nexus-rail` (`"full"` | `"icons"`), applied before paint by the same
  boot script that sets the theme, so the page never jumps.
- Foot: who is signed in (Admin / Staff), the light/dark switch, the sound
  switch (§4), sign out.
- Badges (Team chat unread) stay where they are.
- Phones (≤860px): the dock becomes a floating dark bar 12px above the bottom
  edge, icons only, scrolling sideways as today, with the same sliding pill.
  The staff `MobileTabs` bar keeps its four tabs and takes the same dark style.

`RailLinks` stays the single source of the items (`lib/nav.tsx`); nothing else
renders a copy of them.

## 3. Motion kit

New files: `app/motion.css` (imported by the shell) and `lib/motion.ts`
(helpers), started by a small client component `app/motion-boot.tsx` mounted
once in the shell. Only `transform`, `opacity` and `filter` animate. Everything
is wrapped in `@media (prefers-reduced-motion: no-preference)`; under reduced
motion nothing moves and nothing is hidden waiting to move.

- **Page change.** Cross-document view transitions
  (`@view-transition { navigation: auto; }`), which Chrome, Edge and Safari run
  for the sidebar's plain links. The dock carries `view-transition-name: nx-rail`
  so it stays still; the page column fades and lifts 8px out (140ms) and in
  (260ms). Browsers without the feature load the page normally.
- **Cards rise in.** On first paint, direct children of a page's main column
  and items in its card grids rise 10px and fade in, 45ms apart, capped at the
  first 12 so long lists are never slow. Done in CSS with `animation-delay`
  from a `--i` index that `motion-boot` sets on the first 12 matches.
- **Count-up.** Any element with `data-countup` counts from 0 to its own text
  value (keeping its prefix, suffix and thousands separators) over 700ms the
  first time it scrolls into view. Applied in part 1 to the operator front
  page's stat cards and the staff My Day counts.
- **Draw and grow.** `.nx-draw` on an SVG path draws it left to right
  (stroke-dashoffset, 900ms); `.nx-grow` on a bar grows it from its baseline
  (scaleY, 600ms, staggered by `--i`). Applied in part 1 to the front page's
  overview line chart and its stat-card sparklines; `.nx-grow` waits for part
  2's bar charts.
- **Zoom windows.** `.nx-pop` on a dialog makes it scale up from the point
  that opened it (`--nx-ox`, `--nx-oy`, set by `lib/motion.ts` from the click)
  over a backdrop that blurs (8px) and dims. Applied to the command palette,
  keyboard shortcuts and Ask a colleague dialogs.
- **Side panels.** `.nx-sheet` slides a panel in from the right (320ms) over a
  frosted backdrop. Applied to the assistant panel.
- **Hover and press.** Cards (`.card`, `.glass`, `.panel`) lift 2px with a
  slightly deeper shadow; buttons scale to 0.97 while pressed.

## 4. Sound kit

`lib/sound.ts` synthesises every sound with the Web Audio API — no audio files,
nothing to download. One shared `AudioContext`, created on the first user
gesture (browsers refuse sound before one, so a page's first load is silent).
Master volume 0.22.

| Name | When | Sound |
|---|---|---|
| `whoosh` | a sidebar item is clicked | filtered noise sweep, 180ms |
| `pop` | a `.nx-pop` window or `.nx-sheet` panel opens or closes | short sine blip, rising on open, falling on close |
| `tick` | the theme, sound or collapse switch is flipped | 30ms click |
| `chime` | something is sent or saved | two soft notes |
| `ping` | a new message or assignment alert arrives | single bell note |

`play(name)` is the only entry point; it is also reachable as
`window.dispatchEvent(new CustomEvent("nexus:sound", { detail: "chime" }))`, so
any screen can ask for a sound without importing anything. In part 1 `chime` is
wired to Bulk messaging's "sent" result, and `ping` to `AssignmentAlerts` and
`TeamChatAlerts`; part 2 adds `chime` to each screen's own save and send
results as it rebuilds them.

Mute: a speaker switch in the dock foot. On by default; the choice is kept in
`localStorage` under `nexus-sound` (`"on"` | `"off"`). Muted, `play` returns at
once. No `AudioContext` in the browser, or storage blocked: it stays silent and
never throws.

## 5. Tests and checks

New web tests (`apps/web/test`, same style as the existing ones):

- `every-signed-in-screen-has-the-sidebar` — `app/page.tsx` wraps the operator
  front page in `ConsoleShell`; `deck-console.tsx` no longer renders a `.rail`
  or `initDeckFx`; every `/deck/*` page sits under `app/deck/layout.tsx`.
- `the-cream-theme-reads` — parses the light and dark token blocks and checks
  each text/ground pair listed above is ≥4.5:1.
- `the-sidebar-remembers` — collapse and sliding-pill keys are read before
  paint and survive storage that throws.
- `sound-stays-polite` — `play` is silent when muted, silent without an
  `AudioContext`, and never throws.
- `motion-respects-reduced-motion` — every animation in `motion.css` sits
  inside the no-preference media query.

Existing web and API tests must stay green, and `typecheck` clean.

Visual check: run the web app locally against the mock API
(`.claude/nexus-mock/mock-api.mjs`), open the operator front page, inbox, HQ,
Team, Customers, Bulk messaging and the staff front page in light and dark, at
desktop and phone width, and send the owner screenshots before asking to
deploy.

## Not doing

No new packages. No change to what any screen shows or does — only how it
looks and moves (part 2 changes screens). No changes to the API.
