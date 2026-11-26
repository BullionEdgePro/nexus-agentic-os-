# Staff-first compact Nexus — piece 1: one header everywhere, the daily pages content-first

Date: 26 Nov 2026. Owner's request: "can you do ui and ux more good compact and sleek design be
reliable and creative on entire nexus site specially to use my staff easier". Follows the compact
SFS board and My board (live at 949a008, spec 2026-11-25-compact-sfs-board-design.md), whose
one-line header with the explanation behind an ⓘ is the reference look.

## 1. What staff meet today (recon, 26 Nov 2026)

- 19 pages open with a title and an always-visible explanation paragraph of 23–64 words
  (Answer rules 64, Forecast 51, Appointments 43, My settings 35, Tasks 34, Customers 30, Needs
  attention 30). Staff read it once and scroll past it every day after. 15 of them use the exact
  same markup: `<header className="act-head"><h1>…</h1></header>` then `<p className="act-lede">`.
- On a 375px phone, Tasks shows its first follow-up about 980px down: title, a four-line
  explanation, three large counter boxes, then the "Add a follow-up" form, always open.
  Appointments has the same counter boxes.
- On a phone, My Day's first screen is a large greeting, a "You are clear" band and five tall
  shortcut tiles whose sub-lines are cut off ("Everything ass…"); My board starts near 590px.
- Most pages say "Loading…" in plain text; one missing number in an answer can blank a page
  (Appointments reads `counts.upcoming` from the answer with no fallback).

## 2. Intent, goals, anti-goals

**Why:** staff should see their work first and the explanations only when they ask.

Goals for this piece:
1. **One header for every page** (`PageHead`): the title on one line with an ⓘ button beside it
   and room for actions on the same row. The explanation is still on the page — hidden until ⓘ
   is pressed, so nothing written is lost and screen readers and search still find it.
2. **Follow-ups (Tasks) content-first:** the three counters become one slim strip; "Add a
   follow-up" folds behind a "+ Add a follow-up" button that opens the same form; the list
   comes straight after the strip.
3. **Appointments content-first:** the same slim counter strip; an answer without counts shows
   zeros instead of breaking the page.
4. **My Day compact:** a smaller greeting, the "You are clear" band as one short line, and the
   five shortcuts as compact chips (icon + name; the sub-line only where there is room).
5. **Shortcuts that land ready:** "Add a follow-up" on My Day opens Tasks with the form already
   open (`/deck/tasks?add=1`); "Book an appointment" opens Appointments with its form open
   (`/deck/bookings?add=1`).

Anti-goals (a failure even if it works):
- Nothing staff can do today disappears or moves out of reach.
- No new API, no migration, no change to what any page saves.
- No sideways scroll at 375, 1024 or 1440px; keyboard and screen-reader use keep working (ⓘ and
  the fold buttons say whether they are open).
- Admin-only pages get the same header and keep working; nothing else on them changes.

## 3. Approaches (owner's standing rule: take Claude's recommendation)

- **A. One shared compact system first, then the daily pages.** *(Chosen.)* One component fixes
  19 headers at once and keeps every page consistent; then the deeper fixes go where staff spend
  their day. Low risk: same pages, same data, less clutter.
- B. Redesign only the daily pages, deeper. More visible on four pages; the other fifteen stay
  cluttered and inconsistent.
- C. A whole new look everywhere. Most striking, highest risk, staff must relearn every screen.

## 4. The design

### 4.1 `PageHead` (apps/web/app/kit/page-head.tsx)
- Props: `title` (text), `about` (the explanation, any markup), `children` (actions, optional).
- Renders `<header className="act-head page-head">` with the `<h1>`, an ⓘ button
  (`aria-label="About this page"`, `aria-expanded`, `aria-controls` the paragraph) when there is
  an `about`, and the actions pushed to the right; then `<p className="act-lede">` carrying the
  explanation with `hidden` until ⓘ is pressed.
- Style: the workflow page's look (ⓘ in a small round pebble, dark when open), title
  `clamp(24px, 3vw, 30px)`, tighter top/bottom margins; on a phone the actions wrap under the
  title.
- Used by the 15 pages with the plain header (Agent settings, Appointments, Campaigns, Catalogue,
  Channels, Customers, Forecast, Knowledge, Customer links, My settings, Notifications, Needs
  attention, Answer rules, Agent quality, Tasks) and by Team chat (whose explanation differs for
  admins and staff and currently sits inside its header). The Workflow page keeps its own
  identical header (already compact, pinned by its tests). Section-level explanations
  (Answer rules' phrases, Agent quality's brain section) stay as they are.

### 4.2 Follow-ups (`/deck/tasks`)
- The counters (`open`, `overdue`, `nobody's job`) as one strip of small pills, colours kept
  (overdue red, nobody's job amber when above 0). Same strip style for Appointments.
- "+ Add a follow-up" button (`aria-expanded`) opens the existing form in place; it starts open
  when the address has `?add=1`. Saving closes it (the follow-up appears in the list); a Cancel
  button closes it too, keeping what was typed.

### 4.3 Appointments (`/deck/bookings`)
- The counter strip as above. `counts` from the answer falls back to zeros when missing.
- `?add=1` opens the existing "Book an appointment" form (`AddAppointment` gains a
  `startOpen` prop).

### 4.4 My Day (`/`)
- Greeting one size smaller, less padding; on a phone the date chip sits beside the business
  line, not on its own row.
- The "You are clear" band becomes a single line with a small tick.
- Shortcuts: a wrapping row of compact chips at every width (icon + name); the sub-line shows
  only on wide screens, and is the chip's tooltip otherwise. "Add a follow-up" links to
  `/deck/tasks?add=1`, "Book an appointment" to `/deck/bookings?add=1`.

## 5. Later pieces (not in this one, in this order)
2. My queue (the inbox, the screen staff use most) — compact rows and toolbar.
3. Loading and errors the same everywhere — an outline while loading, a reason and Try again
   when a load fails, never a blank page.
4. Customers, My clients, Knowledge and Answer rules — denser cards and folded forms.
5. The menu for staff — 17 doors today; group or trim, and choose the phone tab bar's four.

## 6. Calls I made (owner can change any)
- The explanation stays in the page, hidden until ⓘ, rather than deleted.
- Workflow keeps its own header (same look) rather than switching to `PageHead` now.
- The add-form fold remembers what was typed when closed with Cancel.
- `?add=1` is the one way a link opens a page's add form.

## 7. Testing
Web tests (SSR, as the repo does): `PageHead` draws the title, the ⓘ with `aria-expanded`, the
explanation present but `hidden`, and actions; no page keeps a bare always-visible
`act-lede` right after an `act-head` header; Tasks draws the strip and the folded form (open with
`?add=1` via its start prop); Appointments with no counts draws zeros; My Day's chips link to the
`?add=1` addresses. Existing suites pass (web, API, typecheck ×4). A look in the preview, signed in
as SFS staff, at 1024px and 375px before asking to deploy.

## 8. Rollout
Web-only change, no migration. Deploy only on the owner's "Deploy it".
