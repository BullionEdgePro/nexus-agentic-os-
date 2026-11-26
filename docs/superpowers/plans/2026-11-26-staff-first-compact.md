# Staff-first compact Nexus (piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One compact header on every page (explanation behind an ⓘ), and My Day, Follow-ups and Appointments content-first.

**Architecture:** A shared client component `PageHead` in the kit replaces the 16 hand-written `act-head` + `act-lede` blocks; the explanation stays in the markup with `hidden`. Follow-ups gets a shared `AddFold` toggle and slim counter pills (CSS shared with Appointments); `?add=1` opens a page's add form. My Day is compacted mostly in CSS, plus two links.

**Tech Stack:** Next.js 14 (app router, client components), React 18, plain CSS files per area, node:test with react-dom/server `renderToStaticMarkup` (no DOM; effects never run).

**Spec:** docs/superpowers/specs/2026-11-26-staff-first-compact-design.md

## Global Constraints

- Web only (apps/web). No API, no migration, no change to what any page saves.
- Nothing staff can do today disappears; every explanation stays on its page, hidden until ⓘ.
- No sideways scroll at 375, 1024, 1440px.
- ⓘ: `aria-label="About this page"`, `aria-expanded`, `aria-controls` = the paragraph's id. Fold buttons: `aria-expanded`.
- Title size `clamp(24px, 3vw, 30px)`.
- `?add=1` is the one way a link opens a page's add form.
- Files stay LF; edit with the Edit/Write tools, never Python text-mode writes.
- Web tests: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/<file>.test.mjs`; whole suite `node test/run.mjs`; typecheck `npm run typecheck -w apps/web` from the repo root.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An explanation that holds a link or bold text (Answer rules, Forecast) — still rendered whole inside `PageHead` and readable when opened. (Task 1 test: `about` with an `<a>`.)
2. ⓘ by keyboard and screen reader — `aria-controls` points at the paragraph's own id, unique per page. (Task 1 test.)
3. A failed follow-up save — the fold stays open with the error; only a saved follow-up closes it. (Task 2 source pin: the close comes after the awaited create.)
4. `?add=1` on Appointments when the business is not chosen yet — nothing breaks; the form opens once the business is known (it only mounts inside a business). (Task 2 test: `startOpen` opens the mounted form.)
5. Phone width — the header's actions and the chips wrap with no sideways scroll. (Hand check in the preview at 375px; SSR cannot see layout.)

---

### Task 1: `PageHead` on every page

**Files:**
- Create: `apps/web/app/kit/page-head.tsx`
- Modify: `apps/web/app/deck/activity/activity.css` (after `.act-lede`, line 33)
- Modify (header block → `<PageHead>`): `app/deck/agent/page.tsx:153-156`, `bookings/page.tsx:171-182`, `broadcasts/page.tsx:177-180`, `catalogue/page.tsx:267-270`, `channels/page.tsx:57-60`, `customers/page.tsx:157-160`, `forecast/page.tsx:119-122`, `knowledge/page.tsx:142-145`, `links/page.tsx:132-135`, `my-settings/page.tsx:67-70`, `notifications/page.tsx:32-35`, `operators/page.tsx:282-285`, `procedures/page.tsx:157-160`, `quality/page.tsx:124-127`, `tasks/page.tsx:182-189`, `team-chat/page.tsx:196-203` (all under `apps/web/app/`)
- Test: `apps/web/test/the-staff-first-compact.test.mjs` (new)

**Interfaces:**
- Produces: `export function PageHead({ title, about, children }: { title: string; about?: ReactNode; children?: ReactNode }): JSX.Element` — renders `<header className="act-head page-head">` with `<h1>{title}</h1>`, the ⓘ button (`className="page-about"`) only when `about` is given, `<div className="page-actions">` only when `children` is given; then `<p id={useId()} className="act-lede" hidden={!open}>{about}</p>`.

- [ ] **Step 1: Write the failing tests** in the new file (header comment naming the spec), using `renderToStaticMarkup(createElement(PageHead, props))`:
  - `"PageHead: the title on one line, the explanation behind an ⓘ"` — with `{ title: "Tasks", about: "What a conversation left someone to do." }`: matches `/<h1>Tasks<\/h1>/`, `/aria-label="About this page"/`, `/aria-expanded="false"/`, `/<p id="([^"]+)" class="act-lede" hidden="">What a conversation left someone to do\.<\/p>/` and the ⓘ's `aria-controls` equals that captured id.
  - `"PageHead: no ⓘ without an explanation; actions sit on the title's row"` — `{ title: "X", children: createElement("button", null, "Refresh") }`: no `About this page`, matches `/<div class="page-actions"><button>Refresh<\/button><\/div>/`, no `act-lede`.
  - `"PageHead: an explanation with a link stays whole"` — `about` = fragment with text and `createElement("a", { href: "/deck/knowledge" }, "Knowledge")`: the `act-lede` paragraph contains `<a href="/deck/knowledge">Knowledge</a>`.
  - `"every page uses PageHead: no explanation is always on screen"` — walk `app/` (`readdirSync(..., { recursive: true })`, `.tsx`): no file except `app/kit/page-head.tsx`, `app/deck/workflow/page.tsx`, `app/deck/procedures/phrases-section.tsx`, `app/deck/quality/brain-section.tsx` contains `className="act-lede"`; no file contains `<header className="act-head">`; each of the 16 pages listed above contains `<PageHead`.
  - `"the ⓘ looks like the board's"` — `activity.css` matches `/\.page-about\[aria-expanded="true"\]/` and `/\.page-head h1 \{[^}]*clamp\(24px, 3vw, 30px\)/`.
- [ ] **Step 2: Run** the new file. Expected: FAIL (module `@/app/kit/page-head` not found — add an empty `export {}` file first so each test fails on its own assertion).
- [ ] **Step 3: Implement `PageHead`** ("use client"; `useState(false)`, `useId()`), and the CSS: `.page-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin: 8px 0 14px; }`, `.page-head h1` with the clamp, `.page-about` (same look as `.wf-about` in workflow.css:14-16, including `:focus-visible`), `.page-actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }`, `.page-head + .act-lede { margin: -6px 0 14px; }`.
- [ ] **Step 4: Migrate the 16 pages.** Each `<header className="act-head"><h1>T</h1></header>` + following `<p className="act-lede">…</p>` becomes `<PageHead title="T" about={<>…</>} />`, the paragraph's content moved verbatim (comments inside stay as JSX comments next to it). Team chat: the admin/staff conditional string becomes `about`. Import from `"../../kit/page-head"` (or `@/app/kit/page-head`, as each file already imports the kit).
- [ ] **Step 5: Run** the new file, then the whole web suite and typecheck. Expected: PASS; suite all green (tests that read explanation text still find it — it is in the markup).
- [ ] **Step 6: Commit** — `feat(ux): one compact header on every page, the explanation behind an ⓘ`.

### Task 2: Follow-ups and Appointments content-first

**Files:**
- Create: `apps/web/app/kit/add-fold.tsx`
- Modify: `apps/web/app/deck/tasks/page.tsx` (form at 206-~298, submit handler), `apps/web/app/deck/tasks/tasks.css` (`.tk-counts`/`.tk-count` 13-56)
- Modify: `apps/web/app/deck/bookings/page.tsx` (`setCounts(data.counts)` at 92; `<AddAppointment>` at ~210), `apps/web/app/deck/bookings/add-appointment.tsx` (props, `open` state at 64)
- Test: `apps/web/test/the-staff-first-compact.test.mjs`

**Interfaces:**
- Consumes: `PageHead` (Task 1).
- Produces: `export function AddFold({ label, open, onOpenChange, children }: { label: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }): JSX.Element` — closed: one `<button type="button" className="add-fold-open" aria-expanded="false">+ {label}</button>`; open: the children followed by `<button type="button" className="kit-pill quiet add-fold-cancel">Cancel</button>`, and the open button shows `aria-expanded="true"`.
- Produces: `AddAppointment` gains `startOpen?: boolean` (default `false`).

- [ ] **Step 1: Write the failing tests:**
  - `"AddFold: shut it is one button; open it shows the form and Cancel"` — closed render matches `/<button type="button" class="add-fold-open" aria-expanded="false">\+ Add a follow-up<\/button>/` and not `Cancel`; open render with child `createElement("form")` matches `<form` and `>Cancel<` and `aria-expanded="true"`.
  - `"Follow-ups: the form folds, opens on ?add=1, and closes only after a save"` — `tasks/page.tsx` matches `/<AddFold[\s\S]{0,80}label="Add a follow-up"/`, `/get\("add"\) === "1"/`, and in the submit handler `/await createTask\([\s\S]{0,400}setAdding\(false\)/` (closes after the awaited create).
  - `"the counters are one slim strip"` — `tasks.css`: `.tk-counts {` rule has `flex-wrap: wrap` and `.tk-count {` rule has `display: inline-flex`; `.tk-count strong {` font-size ≤ 16px (`/font-size: 1[0-6]px/`).
  - `"Appointments: an answer without counts shows zeros, and ?add=1 opens the form"` — `bookings/page.tsx` matches `/setCounts\(data\.counts \?\? /` and `/startOpen=\{/`; `render(AddAppointment, { business: "sfs-international", businessName: "SFS International", timezone: "Asia/Dubai", team: [], onCreated() {}, startOpen: true })` contains `<form`. (The existing "the diary form stays shut" test, without `startOpen`, must keep passing.)
  (Check the name of the create call in tasks/page.tsx's submit before writing the regex; use the real one.)
- [ ] **Step 2: Run.** Expected: the four tests FAIL on their assertions (empty `add-fold.tsx` first).
- [ ] **Step 3: Implement.** `AddFold` as specified. Tasks: `adding` state (false), mount effect reads `?add=1`; wrap the existing `<form className="tk-new">` in `<AddFold label="Add a follow-up" open={adding} onOpenChange={setAdding}>`, drop the form's own "Add a follow-up" sub-heading (the button says it); `setAdding(false)` after a successful create only. CSS: counters as inline pills (`display: inline-flex; align-items: baseline; gap: 6px; padding: 5px 12px; border-radius: var(--r-pill)`; strong 15px; keep the `.bad`/`.warn` colours), `.add-fold-open` styled as the kit's primary pill. Appointments: `setCounts(data.counts ?? { upcoming: 0, today: 0, unassigned: 0 })`; `addOpen` state from `?add=1` passed as `startOpen`; in `AddAppointment`, `useState(startOpen)` plus an effect that opens when `startOpen` turns true.
- [ ] **Step 4: Run** the file, the whole web suite, typecheck. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ux): Follow-ups and Appointments show the work first; ?add=1 opens the add form`.

### Task 3: My Day compact

**Files:**
- Modify: `apps/web/app/my-day.tsx` (shortcuts 110-145), `apps/web/app/my-day.css` (hero 22-87, clear 119-136, actions 140-175, media 297-310)
- Test: `apps/web/test/the-staff-first-compact.test.mjs`

**Interfaces:**
- Consumes: `?add=1` handling from Task 2.

- [ ] **Step 1: Write the failing tests:**
  - `"My Day's shortcuts land ready"` — `my-day.tsx` matches `/href="\/deck\/tasks\?add=1"/` and `/href="\/deck\/bookings\?add=1"/`; every `className="day-action"` link carries a `title=` (count of `className="day-action"` equals count of `className="day-action" title=`).
  - `"My Day is compact: chips that wrap, a smaller greeting, a one-line all-clear"` — `my-day.css`: `.day-actions {` rule has `flex-wrap: wrap`; `.day-hero h1 {` rule's `font-size` is a `clamp(` whose max is ≤ 30px; `.day-clear-mark {` width ≤ 24px; inside a `@media (max-width: 1180px)` block `.day-action small { display: none; }`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Links and `title` (the sub-line text) on each `.day-action`. CSS: hero padding about 18px 20px, h1 `clamp(22px, 2.6vw, 28px)`, eyebrow and date on one wrapping row; `.day-clear` one line (`padding: 8px 12px`, mark 20px); `.day-actions` a wrapping flex row of chips (`.day-action` `padding: 8px 12px`, `border-radius: var(--r-pill)`, icon 28px), sub-line hidden under 1180px; remove the old grid-column rules in the media blocks.
- [ ] **Step 4: Run** the file, the whole web suite, typecheck. Expected: PASS ("My Day's counts count up" keeps its 3 `data-countup`).
- [ ] **Step 5: Commit** — `feat(ux): a compact My Day — smaller greeting, one-line all-clear, shortcut chips`.
