# Staff-first compact Nexus — piece 4: loading and errors the same everywhere

Date: 26 Nov 2026. Owner: "Yes, next piece" — piece 3 of the staff-first pass's §5 list
(2026-11-26-staff-first-compact-design.md): "an outline while loading, a reason and Try again when
a load fails, never a blank page".

## What a person meets today (code scan, 26 Nov 2026)
- 19 deck pages and sections say a bare **"Loading…"** line while they load (tasks, bookings,
  customers, knowledge, procedures, my-settings ×2, notifications, forecast, board, operators,
  agent, broadcasts, catalogue, quality, channels, links, workflow, response times, Answer rules'
  phrases, Agent quality's brain section).
- When a page's load fails it prints the reason as a plain sentence (`act-msg`, `cu-err-load`,
  `bd-err-load`, `ag-err-load`, `set-error`) and **no deck page offers Try again** — the only way
  back is reloading the whole browser page. (Pages already refuse to draw stale data under the
  error — that rule stays.)

## The design
- Two kit pieces in `apps/web/app/kit/load-states.tsx`, styled by their own
  `apps/web/app/kit/load-states.css` (each page that uses them imports it; tests render the pieces,
  never the pages, so no stylesheet is imported by a component):
  - `PageLoading({ rows = 3 })` — an outline: `role="status"`, a visually hidden "Loading…" for
    screen readers, and `rows` soft grey bars that shimmer (still under reduced motion).
  - `LoadFailed({ reason, onRetry })` — `role="alert"`: the reason, and a **Try again** button that
    calls the page's own `load` again.
- **Every page-level "Loading…"** above becomes `<PageLoading />`.
- **Every page with a `load` function** shows its failed load as `<LoadFailed reason={loadError}
  onRetry={() => void load(…the same arguments its effect uses…)} />`: tasks, bookings, customers,
  knowledge, procedures, my-settings, forecast, board, operators, agent, broadcasts, catalogue,
  quality — and notifications, whose `getMe` call becomes a `load` it can call again.
- Pages without a load function to call (channels, links, workflow, response times, the two
  sections) get the outline only; their error lines stay as they are.
- Small inline waits inside the inbox's pop-ups (Ask a colleague, the custody list, the
  collaborator list, the team dock) are left alone — one word in a small box is the right size.

## Approaches
- **A. Two shared kit pieces, swapped in page by page.** *(Chosen: one look, one behaviour, each
  page keeps its own load logic and its stale-data rule.)*
- B. A wrapper that owns each page's loading state — every page's data flow rewritten; risky.
- C. CSS only (restyle `act-empty` while loading) — no Try again, which is the half that matters.

## Calls I made
- The reason keeps the page's own words (from `readableError`); the button is always "Try again".
- Three bars by default; the outline is not shaped like each page's content (YAGNI).
- Under reduced motion the bars stay still.

## Testing
Render tests for both pieces; a source scan that no listed page keeps a visible "Loading…" or a
bare `{loadError}` line, that each listed page wires `onRetry` to its own `load`, and imports the
stylesheet; the CSS stills the shimmer under reduced motion. The workflow test that pinned the
literal "Loading…" now pins the outline. Web suite and typecheck; a look in the preview at a slow
and a failing load.

## Rollout
Web only, no migration. Deploy only on the owner's "Deploy it".
