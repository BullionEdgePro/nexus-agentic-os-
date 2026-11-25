# Compact SFS Board + "My board" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Workflow Board compact and quick to scan, and show each staff member a "My board" card on My Day.

**Architecture:** The board stays one component (`board-view.tsx`) fed by the existing `GET /api/organizations/:slug/workflow-board`; the server adds the viewer to the board answer and cleans the hot-leads list. Two pure helpers in `apps/web/lib/workflow/` (column order, My Board summary) carry the logic so it is unit-testable; the screens render them.

**Tech Stack:** Next.js/React (web), Hono + Postgres (api/db), node:test with `renderToStaticMarkup`.

**Spec:** `docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md`

## Global Constraints

- No migration, no new table. No new API route (one field added to the board answer).
- Staff still never see a colleague's deal: the "+N with colleagues" counts stay.
- Everything a user can do today stays: Add unit / Add lead, drag and move menu, open a card, Refresh, Portal settings, Waiting longest, Closed in the last 30 days, Live picture tab, business pills for admins.
- House style: dated header comment (25 Nov 2026) saying what and why, ending `Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §n`.
- Staff-facing words exactly: "Show all (N)", "Show fewer", "Mine", "Only mine", "Empty steps", "My board", "Open board →", "Needs me", "Nothing of yours on the board", "Could not load your board", "Runs by itself · 30 days:".
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.
- Tests: web `cd apps/web && node test/run.mjs` (one file: `TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/<f>.test.mjs`); API one file with the DB env (`AUDIT_TEST_OWNER_URL`/`AUDIT_TEST_APP_URL`, throwaway Postgres on 55441).

## Review Focus

1. A staff member with no employee record (an admin "viewing as staff") — Mine/Only mine/My Board must not crash; My Board shows nothing of theirs.
2. Dragging a card onto an empty step that is shown as a chip — the drop must still work.
3. `?card=<id>` for a card the viewer cannot see or that is closed — the board opens normally with no detail and no error.
4. A permit date already past — "Needs me" says "permit expired", not "expires".
5. A contact whose number is stored with "+", spaces or dashes vs digits — the hot-leads exclusion compares digits only.

---

### Task 1: Board answer carries the viewer; hot leads leave out non-buyers

**Files:**
- Modify: `packages/shared/src/workflows/board.ts` (type `Board`)
- Modify: `packages/db/src/workflow-board.ts` (`getBoard`, hot-leads query ~L467)
- Modify: any web/test fixture building a `Board` that typecheck flags
- Test: `apps/api/test/the-compact-board.test.mjs` (new)

**Interfaces:**
- Produces: `Board.viewer: { employeeId: string | null; seesAll: boolean }`

- [ ] **Step 1: Write failing tests** — `the-compact-board.test.mjs` seeds an org "SFS International" with an employee whose `whatsapp_number` is "+971 50 480 5436", another org "Juris Prime Legal" with an employee number "971500000001", and high-priority `lead_assessments` (last 30 days) for contacts: A "Real Buyer" wa_id 971501111111; B "SFS INTERNATIONAL REAL ESTATE LLC" wa_id 971502222222; C "Juris Prime Legal Consultancy & Law Firm" wa_id 971503333333; D "Atif" wa_id "971504805436"; E "Other" wa_id "971500000001". Assert `getBoard(...).hotWaiting.map(h=>h.name)` deep-equals `["Real Buyer"]`, and `board.viewer` equals `{ employeeId: <staff id>, seesAll: false }` for a staff viewer.
- [ ] **Step 2: Run, expect FAIL** (all five names returned; `viewer` undefined).
- [ ] **Step 3: Implement** — add `viewer` to the returned board. In the hot-leads `where`, add: digits-only `ct.wa_id` not in digits-only `employees.whatsapp_number` of any organization (`regexp_replace(x, '\D', '', 'g')`); and no organization whose `name` (length ≥ 4) is contained, case-insensitively, in the contact's shown name. Keep `limit 20`.
- [ ] **Step 4: Run, expect PASS**; also run `the-workflow-board*.test.mjs` API tests if present and `npm run typecheck -w packages/shared -w packages/db -w apps/api -w apps/web`.
- [ ] **Step 5: Commit** `feat(board): the board names its viewer; hot leads leave out our own and sister businesses`

### Task 2: Compact board layout

**Files:**
- Create: `apps/web/lib/workflow/board-layout.ts`
- Modify: `apps/web/app/deck/workflow/page.tsx` (header + ⓘ), `apps/web/app/deck/workflow/board/board-view.tsx`, `apps/web/app/deck/workflow/workflow.css`
- Test: `apps/web/test/the-compact-board.test.mjs` (new)

**Interfaces:**
- Produces: `splitColumns(columns: WorkflowStep[], cards: BoardCard[], hidden: Board["hidden"]): { filled: WorkflowStep[]; empty: WorkflowStep[] }` (each in workflow order); `HOT_SHOWN = 5`.

- [ ] **Step 1: Write failing tests** — (a) `splitColumns` with cards on S6 only → filled `[S6]`, empty the rest in order; a demand step with `hidden[step] = 2` counts as filled. (b) Render `WorkflowBoardView` with 7 hot leads: markup contains 5 names and "Show all (7)". (c) Empty steps render inside an element with class `wf-board-empty-steps` with text "Empty steps" and each chip showing name and 0; when `drag.dragging` is set (pass a `dragging` test hook or check the `data-dragging` attribute), empty steps render as full columns. (d) "Runs by itself · 30 days:" appears once per lane as one line (class `wf-board-auto-line`). (e) page.tsx: the lede text is inside an element hidden until the ⓘ button (`aria-label="About this page"`, `aria-expanded`) is pressed; the h1 reads "SFS International · Board" when the Board tab is active — source check on page/panel is acceptable where rendering needs the API.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — board-view: lanes render `filled` columns as a wrapping grid (CSS `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))` on `.wf-board-lane`, no horizontal scroll), then an "Empty steps" chip row; while any card is being dragged the empty steps render as normal `BoardColumn`s so drops work. Hot leads: first `HOT_SHOWN`, toggle "Show all (N)" / "Show fewer". "Runs by itself" becomes one line: `Runs by itself · 30 days: <name> <value> · …`. Closed-in-30-days and Waiting longest sit in one slim row (CSS). page.tsx: one-line header, lede behind the ⓘ toggle.
- [ ] **Step 4: Run, expect PASS**; run `the-workflow-board`, `the-board-in-cream`, `the-workflow-in-cream`, `the-workflow-tab` web tests and update only assertions the spec changed (state which in the commit body).
- [ ] **Step 5: Commit** `feat(board): a compact board — steps wrap, empty steps fold, five hot leads, one-line header`

### Task 3: Mine, Only mine, and opening a card by link

**Files:**
- Modify: `apps/web/app/deck/workflow/board/board-view.tsx`, `board-card.tsx`, `board-panel.tsx`, `workflow.css`
- Test: `apps/web/test/the-compact-board.test.mjs`

**Interfaces:**
- Consumes: `Board.viewer` (Task 1), `splitColumns` (Task 2).
- Produces: `isMine(card: BoardCard, viewer: Board["viewer"]): boolean` exported from `apps/web/lib/workflow/board-layout.ts` (true when `viewer.employeeId` and `card.agent?.id === viewer.employeeId`); the board page opens `?card=<id>`.

- [ ] **Step 1: Write failing tests** — `isMine` true/false/null-employee cases; a staff board renders a "Mine" tag on their card and lists it first within its step; with `onlyMine` on, a colleague's unit is not rendered; an admin board (`seesAll: true`) renders no "Only mine" toggle; board-panel source opens the card whose id is in `?card=` after the board loads, and ignores an unknown id.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — toggle "Only mine" (staff only, off by default, a pill beside Refresh); within each step sort mine first then by `inStepSince`; `WorkflowCard` gets `mine` prop → small "Mine" tag. board-panel: on first board load read `card` from `location.search`, `setOpened({ id, el: null })` if that id is on the board.
- [ ] **Step 4: Run, expect PASS** plus the board web tests.
- [ ] **Step 5: Commit** `feat(board): staff see their own cards first, marked Mine, with an Only mine switch; ?card= opens a card`

### Task 4: "My board" on My Day

**Files:**
- Create: `apps/web/lib/workflow/my-board.ts`, `apps/web/app/my-board.tsx`
- Modify: `apps/web/app/my-day.tsx`, `apps/web/app/my-day.css`
- Test: `apps/web/test/the-my-board.test.mjs` (new)

**Interfaces:**
- Consumes: `isMine` (Task 3), `getWorkflowBoard(slug)`, `boardColumns`, `moveProblem`, `isPublished`.
- Produces: `myBoardSummary(workflow: Workflow, board: Board, now: number, timezone: string): { units: { step: string; name: string; n: number }[]; deals: { step: string; name: string; n: number }[]; liveOnBayut: number; needsMe: { cardId: string; text: string }[] }`

- [ ] **Step 1: Write failing tests** — fixtures with viewer e1 and cards of e1 and e2: counts include only e1's cards, zero steps left out, in workflow order; `liveOnBayut` counts e1's units whose bayut row is live; needsMe order and words: portal refused → `"<title> — Bayut refused it"`; permit expiring within 14 days of `board.today` → `"<title> — permit expires <d MMM>"`, past → `"<title> — permit expired"`; viewing today in the business timezone → `"<name> — viewing today <h:mm am/pm>"`; a card blocked from its next step → `"<title> — <moveProblem text>"`; at most 5. Render `MyBoard` states: summary lines, "Nothing of yours on the board", "Could not load your board"; each needs-me line links to `/deck/workflow?card=<id>`; "Open board →" links to `/deck/workflow`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — `my-board.ts` pure summary (card title via the board's `cardTitle`; next step = the column after the card's step in `boardColumns`). `my-board.tsx`: loads the board for the staff member's own business (`useVisibleBusinesses().mySlug`) only when `workflowFor(slug)` exists and the viewer is staff; renders nothing for admins or businesses without a board. Placed in My Day's main column after the counters.
- [ ] **Step 4: Run, expect PASS** plus existing My Day web tests.
- [ ] **Step 5: Commit** `feat(my-day): a My board card — my units and deals by step, and what needs me`

### Task 5: Whole check

- [ ] Typecheck all four workspaces; full web suite; the API board tests; then look at the board and My Day in the browser against a mock API at 1440px and 390px wide (no horizontal scroll, empty-step chips, five hot leads, Mine tag, My Board card).
- [ ] One fresh reviewer on the whole branch; fix what it finds; report.
