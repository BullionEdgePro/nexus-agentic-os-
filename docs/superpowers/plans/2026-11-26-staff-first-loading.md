# Staff-first compact Nexus (piece 4): loading and errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every deck page shows an outline while it loads and, when its load fails, the reason with a Try again that loads it again.

**Architecture:** `PageLoading` and `LoadFailed` in `apps/web/app/kit/load-states.tsx` (+ `load-states.css`), swapped into each page in place of its "Loading…" line and its bare `{loadError}` line; `onRetry` calls the page's own `load` with the arguments its effect already uses.

**Tech Stack:** React 18 client pages, CSS, node:test (render tests for the pieces, source pins for the pages).

**Spec:** docs/superpowers/specs/2026-11-26-staff-first-loading-design.md

## Global Constraints
- No page draws stale data under a failed load (keep each page's `loadError ? null : …` rule).
- Try again calls the page's own `load(…)` with the same arguments as its effect.
- Pieces import no CSS; each page imports `../../kit/load-states.css` (board: its own relative path).
- LF; Edit/Write (CRLF files such as broadcasts/page.tsx keep CRLF). Tests: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/the-staff-first-loading.test.mjs`; suite `node test/run.mjs`; typecheck `npm run typecheck -w apps/web`.

## Review Focus
1. Try again while the page is already loading again — no double request harm (load sets its own loading/error state each time). (Hand check: press twice.)
2. A failed load after a successful one — the old data must not show under the error. (Pin: `loadError ? null` kept.)
3. Screen readers — "Loading…" is still announced; the error is an alert. (Render test.)
4. Reduced motion — the bars stay still. (CSS pin.)
5. Notifications' load moved into a function — still runs once on open. (Pin: `useEffect(() => { load(); }, [load]);`.)

---

### Task 1: the pieces
**Files:** Create `apps/web/app/kit/load-states.tsx`, `apps/web/app/kit/load-states.css`; Test `apps/web/test/the-staff-first-loading.test.mjs` (new).
**Produces:** `PageLoading({ rows?: number }): JSX.Element`; `LoadFailed({ reason: string; onRetry: () => void }): JSX.Element`.
- [ ] Failing tests: PageLoading renders `role="status"`, a `kit-sr` "Loading…", three `kit-skel` bars (rows 2 → two); LoadFailed renders `role="alert"`, the reason, `<button type="button" class="kit-failed-retry">Try again</button>`; CSS has `.kit-skel` animation and a `prefers-reduced-motion` rule with `animation: none`.
- [ ] Run → FAIL; implement; run → PASS; commit `feat(kit): an outline while loading and a Try again when a load fails`.

### Task 2: every page
**Files:** the 19 pages/sections in the spec; `apps/web/test/the-workflow-in-cream.test.mjs:205`; the new test file.
- [ ] Failing tests: for each listed file no visible `>Loading…<`/`Loading…</` text; contains `<PageLoading`; imports `kit/load-states.css`; for the 14 retry pages: `<LoadFailed reason={loadError} onRetry={() => void load(` (notifications: `onRetry={load}`) and no `{loadError}</p>`; notifications has `const load = useCallback(` and `useEffect(() => {\n    load();\n  }, [load]);`.
- [ ] Run → FAIL; swap page by page (script for the identical lines, Edit for the rest); update the workflow test's `/Loading…/` to `/<PageLoading/`; run file, suite, typecheck → PASS; commit `feat(ux): every page loads with an outline and offers Try again when a load fails`.
