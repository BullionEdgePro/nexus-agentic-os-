# The SFS workflow, as a tab of its own — design

**Date:** 3 Nov 2026. **Branch:** `sfs-workflow-tab`, cut from live `main` (`f005af3`).
**Status:** approved under the owner's standing instruction to take Claude's recommendation. The owner
asked for the workflow to be "real, reliable and creative", in a tab for SFS. They were offered a live
picture or a working board that staff drag cards across, and did not pick. This is the live picture. The
board stays on offer as its own piece of work: it needs new tables and a design session.

## 1. What changes for a person

- **Business HQ.** On SFS International's Business HQ, a **Workflow** tab sits beside Overview, Team, Website,
  SEO, Social and Vault. It shows the whole live workflow in place. The "Workflow audit" button in the
  header goes, because the tab replaces it. A business without a drawn workflow shows no such tab.
- **Staff rail.** The staff rail item is renamed from "Workflow audit" to **Workflow**. Access is unchanged:
  staff see their own business, and operators can see any business with a workflow.
- **What every view shows, top to bottom:**
  1. period pills (7, 30 or 90 days), and "Updated … ago" with a Refresh button;
  2. **Pulse**: progress per lane, where it is stuck, and the lead trend;
  3. the two lanes;
  4. the period's tiles and charts;
  5. the funnel;
  6. Dubai compliance.

## 2. Reliable

- **Loading** shows a placeholder outline of the page, marked `aria-busy`, not a bare "Loading…".
- **Failure** shows what went wrong and a **Try again** button that asks again.
- **Refresh** asks again and keeps the current figures on screen until the new ones arrive. "Updated"
  counts from the moment this browser received the figures; it is not a server time.
- **A late answer is ignored.** An answer that arrives after a newer question (another period, a
  refresh) is still dropped, as today.
- **A quiet period.** If nothing at all was recorded in the period, the panel says so in words rather than
  showing a wall of zeros.
- **Real data only.** Every number on the Pulse comes from the audit response. Nothing is estimated,
  extrapolated, or compared with a period the API was not asked for.

## 3. Creative: the Pulse

Pure functions in `apps/web/lib/workflow/pulse.ts`, drawn by `apps/web/app/deck/workflow/pulse.tsx`.

- **`laneProgress(workflow, evidence)`.** For each lane (supply, demand), its steps in order with each
  step's `stepStatus`, and how many are working. Drawn as one bar per lane, a segment per step in its
  status colour, with a title on each segment, and "3 of 10 working".
- **`whereStuck(workflow, audit)`.** Up to four items, each built only from figures in the audit:
  - **The funnel's steepest drop.** Between consecutive funnel stages (leads → scored → hot → booked →
    held → won), the largest fall whose earlier stage is above zero. Shown as "154 → 59".
  - **Built steps that sat idle.** Steps whose status is `idle` in the period, named.
  - **Chats waiting for a reply.** `replies.unanswered`, when above zero.
  - **Follow-ups past due now.** `followUps.overdueNow`, when above zero.
  - When there are none, a single "Nothing is stuck in the last N days" item.
- **`leadTrend(series.leads)`.** The period's total, the busiest bucket (or none if every bucket is
  zero), and the points for a sparkline. A day bucket reads "busiest day"; a week bucket, "busiest week".

## 4. Phone width

At 640px and below, the Pulse cards stack into one column, the progress bars keep their full width, and
the header row (pills, Updated and Refresh) wraps.

## 5. Structure

- `apps/web/app/deck/workflow/panel.tsx` (new): `WorkflowPanel({ slug })`. It holds the period,
  fetching, the late-answer guard, the loading, error and quiet states, Updated and Refresh, every
  section, and the step window.
- `page.tsx` keeps its job: deciding whose workflow (staff their own, an operator's choice) and the
  page header. It renders `WorkflowPanel`.
- `hq/[slug]/tabs.tsx`: `HqTab` gains `"workflow"`, and a new `tabsFor(slug)` lists the tabs a business
  has. `page.tsx` there checks the URL hash against `tabsFor(slug)`.
- `nav.tsx` and the command palette show the label "Workflow". Their rules are unchanged.

## 6. Out of scope

- The working board (option 2 above).
- Comparisons with the previous period, which would need a second API call and API work.
- Any change to the API or database.

## 7. Testing

The web tests use `renderToStaticMarkup` and source checks, as the existing workflow tests do.

- **`pulse.ts`.**
  - Lane counts match `stepStatus`.
  - The steepest drop is picked correctly, and a stage of zero is skipped.
  - Idle steps are named.
  - Unanswered chats and overdue follow-ups appear only when above zero.
  - "Nothing is stuck" appears when every check is clear.
  - The trend's total and peak are right, and a period of all zeros has no peak.
  - Every number in the Pulse's markup appears in the fixture audit.
- **The panel**, by source check:
  - Try again and Refresh call the loader;
  - Updated is shown;
  - the late-answer guard remains;
  - the loading outline is `aria-busy`;
  - the quiet-period sentence is present.
- **HQ.**
  - `tabsFor("sfs-international")` includes Workflow; another business's does not.
  - `HqBusinessView` on the Workflow tab renders the panel.
  - The header button is gone.
- **Nav** reads "Workflow".
- The existing workflow tests keep passing, updated where they pin the old title.
- `npx next build` passes.
