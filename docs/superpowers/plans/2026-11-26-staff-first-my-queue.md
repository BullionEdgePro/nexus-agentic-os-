# Staff-first compact Nexus (piece 2): My queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On My queue, staff see their chats first: the folder sidebar folds behind a "Filters" button (with a count), the queue chips fit one phone row, and a staff member's own rows drop the line that names them.

**Architecture:** Three pure rules in `apps/web/lib/inbox-layout.ts`, wired into `apps/web/app/inbox/page.tsx` with one state, one class and one button; CSS in `apps/web/app/inbox/inbox.css`.

**Tech Stack:** Next.js 14 client page, React 18, CSS, node:test (SSR-only; the inbox page itself is not rendered in tests — it needs the app router — so its wiring is pinned by source).

**Spec:** docs/superpowers/specs/2026-11-26-staff-first-my-queue-design.md

## Global Constraints
- Web only. Admins see the inbox exactly as today (sidebar open unless they fold it).
- No folder, filter or action disappears; the Filters button says how many filters are on.
- Stored key `nexus.inbox.filters` = "open" | "closed", read and written in try/catch.
- No sideways page scroll at 375, 1024, 1440px.
- LF files; Edit/Write tools only. Tests: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/the-staff-first-queue.test.mjs`; suite `node test/run.mjs`; typecheck `npm run typecheck -w apps/web`.

## Review Focus
1. A staff member who picked "SLA breached" in Filters and folded it — the button must say "Filters · 1" and the list title the folder's name. (Task 1 count test; Task 2 title untouched.)
2. Storage refused (private window) — the inbox still opens folded for staff, open for admins. (Task 1 rule test with stored null.)
3. An admin who once folded it — stays folded for them (the stored choice wins). (Task 1 test.)
4. The role arrives after the first render — the fold must be decided once the role is known, not on the first render. (Task 2 source pin: effect on `known`.)
5. Phone width with four long chip counts — no page sideways scroll. (Hand check at 375px.)

---

### Task 1: the rules

**Files:** Create `apps/web/lib/inbox-layout.ts`; Test `apps/web/test/the-staff-first-queue.test.mjs` (new).

**Interfaces — Produces:**
- `filtersStartOpen(isStaff: boolean, stored: string | null): boolean`
- `activeFilterCount(f: { folder: string; tag: string | null; channel: string | null; dateRange: string; stage: string | null; owner: string }, queueKeys: readonly string[] | null): number`
- `showsAssignee(c: { assignedEmployeeId: string | null }, myEmployeeId: string | null): boolean`

- [ ] **Step 1: failing tests** — `filtersStartOpen`: (true,null)→false, (false,null)→true, (true,"open")→true, (false,"closed")→false, (true,"junk")→false. `activeFilterCount` with Q = ["awaiting","snoozed","followup","mine"]: base `{folder:"awaiting",tag:null,channel:null,dateRange:"any",stage:null,owner:""}`→0; folder "late"→1; + tag "villa"→2; + channel, dateRange "7d", stage "Viewing", owner "e2" → 6; admin (queueKeys null) folder "late"→0, with tag→1. `showsAssignee`: own (e1,e1)→false; other (e2,e1)→true; unassigned (null,e1)→true; admin (e1,null)→true.
- [ ] **Step 2: run** — FAIL (module exports nothing; create `export {}` first).
- [ ] **Step 3: implement** the three functions.
- [ ] **Step 4: run** — PASS. **Step 5: commit** `feat(inbox): the rules for a folded Filters panel and a quieter row`.

### Task 2: the page and its styles

**Files:** Modify `apps/web/app/inbox/page.tsx` (state near 362; root className at 767; list header 975-1015; row sub-line 1174-1180), `apps/web/app/inbox/inbox.css` (after `.ibx.no-details` at 50; media 1443/1471; chips 1762).

**Interfaces — Consumes:** Task 1's three functions; `QUEUE_KEYS`, `myEmployeeId`, `known` already in the page.

- [ ] **Step 1: failing tests** (source and CSS pins, same file):
  - `"staff start with Filters folded; the button says how many are on"` — page matches `/filtersStartOpen\(!!myEmployeeId, /`, `/localStorage\.getItem\("nexus\.inbox\.filters"\)/`, `/className=\{\`ibx\$\{detailsOpen[^`]*\$\{filtersOpen \? "" : " side-folded"\}/`, a button with `aria-expanded={filtersOpen}` whose text is `Filters` and shows `activeFilterCount(` when above 0, and `/localStorage\.setItem\("nexus\.inbox\.filters"/` in a try.
  - `"a staff member's own rows leave out the line that names them"` — page matches `/showsAssignee\(conversation, myEmployeeId\) \? \(/` around the `ibx-convo-sub` span.
  - `"folded is folded at every width, and the chips keep one row on a phone"` — CSS matches `/\.ibx\.side-folded \.ibx-side \{ display: none; \}/`, a ≥1100px folded grid with a 0 side column (`/\.ibx\.side-folded \{[^}]*grid-template-columns: 0 /`), the 1100px and 760px folded areas without "side", and under 760px `/\.ibx-chips \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/`.
- [ ] **Step 2: run** — FAIL.
- [ ] **Step 3: implement.** `const [filtersOpen, setFiltersOpen] = useState(true)`; an effect on `[known, myEmployeeId]` that, once `known`, reads the stored value (try/catch) and sets `filtersStartOpen(!!myEmployeeId, stored)` once (a ref); `toggleFilters()` flips and stores. Root class adds `side-folded`. The Filters button sits first in the list header's buttons: `className="ibx-filters-btn"`, text "Filters", and `<span className="ibx-filters-n">{n}</span>` when `n > 0`, where `n = activeFilterCount({...}, myEmployeeId ? QUEUE_KEYS : null)`. Row: wrap the `ibx-convo-sub` span in `showsAssignee(conversation, myEmployeeId) ? ( … ) : null`. CSS per the test, plus a pill look for `.ibx-filters-btn` (and `.on` when open).
- [ ] **Step 4: run** the file, the suite, typecheck — PASS. **Step 5: commit** `feat(inbox): staff see their chats first — Filters folds away, one row of chips, no self-name line`.
