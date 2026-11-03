# The SFS workflow tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, read-only Workflow tab for SFS International in Business HQ, plus the same panel on
`/deck/workflow`. It is reliable (loading, error with retry, Updated + Refresh, quiet period) and
creative (a Pulse: progress per lane, where it is stuck, lead trend), and it works at phone width.

**Architecture:** Extract the audit UI from `deck/workflow/page.tsx` into `WorkflowPanel({ slug })`.
Add pure Pulse functions in `lib/workflow/pulse.ts`, drawn by `deck/workflow/pulse.tsx`. HQ gains a
`workflow` tab via `tabsFor(slug)`. Nothing changes in the API or database.

**Tech Stack:** Next.js 14 client components, `@nexus/shared` workflows, node:test with tsx and `renderToStaticMarkup`.

**Spec:** `docs/superpowers/specs/2026-11-03-sfs-workflow-tab-design.md`

## Global Constraints

- **Real data only.** Every number shown comes from the `WorkflowAudit` response.
- **Exact copy:**
  - `Workflow` (rail, HQ tab, page title);
  - `Try again`;
  - `Refresh`;
  - `Updated just now` / `Updated N min ago` / `Updated N h ago`;
  - `Nothing is stuck in the last N days`;
  - `Nothing was recorded in the last N days.`.
- **Access rules unchanged.** Staff see their own business; operators choose.
- **Tests:**
  - web: `npm --prefix apps/web test`;
  - typecheck: `npx tsc --noEmit -p .` in `apps/web`;
  - build: `npx next build` in `apps/web`.
- **Commits:** locally only, ending with the attribution line.

## Review Focus

1. A Refresh failing after a success. The figures already shown must stay, with the error beside them, not be blanked.
2. Switching period quickly, then Refresh. Only the newest answer may land.
3. An HQ URL with `#workflow` for a business that has no workflow. It must fall back to Overview, not render an empty tab.
4. A period with zero leads in every bucket. The sparkline must not divide by zero and there must be no "busiest" claim.
5. Phone width: the lanes are wide. The page may scroll sideways inside the lanes, but the Pulse must not.

---

### Task 1: The Pulse (pure functions and drawing)

**Files:** create `apps/web/lib/workflow/pulse.ts`, `apps/web/app/deck/workflow/pulse.tsx` and
`apps/web/test/the-workflow-tab.test.mjs`. Add Pulse styles to `workflow.css`.

**Produces:**
- `laneProgress(workflow, evidence) → { lane: Lane; label: string; steps: { id; name; status: StepStatus }[]; working: number; total: number }[]`
- `whereStuck(workflow, audit) → { kind: "drop" | "idle" | "unanswered" | "overdue" | "clear"; title: string; detail: string; href: string | null }[]`
- `leadTrend(series) → { total: number; peak: { bucket: string; count: number } | null; points: number[]; unit: "day" | "week" }`
- `WorkflowPulse({ workflow, audit })`

- [ ] **Test first.** Fixture audit (SFS); assertions as in spec §7 `pulse.ts`, plus a render check of `WorkflowPulse` showing that every number in its text appears in the fixture.
- [ ] **Run.** Expect FAIL: the module is missing.
- [ ] **Implement.**
- [ ] **Run.** Expect PASS. Then the web suite.
- [ ] **Commit:** `Workflow pulse: progress per lane, where it is stuck, the lead trend`

### Task 2: WorkflowPanel, reliable

**Files:** create `apps/web/app/deck/workflow/panel.tsx`. Modify `page.tsx`, `workflow.css`,
`the-workflow-in-cream.test.mjs` (pinned title or page shapes) and `the-workflow-tab.test.mjs`.

**Consumes:** `WorkflowPulse` from Task 1.

**Produces:** `WorkflowPanel({ slug }: { slug: BusinessSlug })`.

- [ ] **Test first** (source checks, spec §7 "The panel"). The page now renders `<WorkflowPanel slug=` and its title is `Workflow`.
- [ ] **Run.** Expect FAIL.
- [ ] **Implement.**
  - Behaviour:
    - Refresh keeps `audit` and sets `refreshing`;
    - an error during a refresh keeps the figures and shows the error with Try again;
    - `fetchedAt` is set on success;
    - a 30-second tick re-renders the "Updated" label;
    - the quiet check is "every evidence count and the funnel are zero".
  - Loading outline: three grey blocks with class `wf-skeleton`, the container `aria-busy="true"`.
- [ ] **Run the tests and `tsc`.** Expect PASS.
- [ ] **Commit:** `Workflow panel: one panel for the page and HQ, with retry, refresh and Updated`

### Task 3: The HQ tab and the name

**Files:** modify `hq/[slug]/tabs.tsx` and `hq/[slug]/page.tsx`, `lib/nav.tsx`, `command-palette.tsx`
(if it carries the label), and any test pinning "Workflow audit".

**Consumes:** `WorkflowPanel`.

**Produces:** `tabsFor(slug: string): { id: HqTab; label: string }[]`.

- [ ] **Test first** (spec §7 "HQ" and "Nav").
- [ ] **Run.** Expect FAIL.
- [ ] **Implement.**
  - The header button goes.
  - The HQ page's hash check uses `tabsFor(data?.business.slug ?? params.slug)`.
  - `#workflow` without a workflow falls back to Overview.
- [ ] **Run the web suite, `tsc`, and `npx next build`.**
- [ ] **Commit:** `Business HQ: a Workflow tab for SFS; the rail item is Workflow`
