# Staff-first compact Nexus (piece 5): Customers, My clients, Knowledge, Answer rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The four pages open on the staff member's own business, show their list first with forms folded, and fit more on a phone.

**Architecture:** One pure decision `pageBusinessFor` + hook `usePageBusiness` in `lib/business-tabs.tsx`, used by Customers, Knowledge, Answer rules and Forecast; the live `AddFold` for the Knowledge and Answer rules forms; `PageHead` on My clients; CSS for the denser cards, slim counters and the My clients phone rows.

**Tech Stack:** React 18 client pages, CSS, node:test (render tests for pure functions, source and CSS pins for pages).

**Spec:** docs/superpowers/specs/2026-11-26-staff-first-pages-design.md

## Global Constraints
- No API change; no page loses a feature; explanations go behind ⓘ, forms behind "+ …".
- A one-business page loads nothing until it knows who is asking (`ready`); staff always get their own slug.
- Keep each page's stale-data rule (`loadError ? null`).
- Components rendered by tests import no CSS. LF (CRLF files keep CRLF).
- Tests: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/the-staff-first-pages.test.mjs`; suite `node test/run.mjs`; typecheck `npm run typecheck -w apps/web`.

## Review Focus
1. Staff whose `getMe` fails (fails closed: employee, no slug) — the page must not hang on the outline; it asks with the fallback and shows the server's reason with Try again. (Pin: `pageBusinessFor` case.)
2. An admin switching business after load — their choice sticks; staff can never switch. (Pin: operator case uses `chosen`.)
3. Answer rules' phrases section must not load the wrong business before `ready`. (Pin: rendered only when ready.)
4. My clients on a phone — no sideways scroll; Hand back still reachable. (Preview: docW = 375.)
5. Knowledge "?add=1" opens the fold; a save closes it, a failed save keeps it open with the text. (Pin + hand check.)

---

### Task 1: staff open their own business
**Files:** Modify `apps/web/lib/business-tabs.tsx`, `apps/web/app/deck/{customers,knowledge,procedures,forecast}/page.tsx`; Test `apps/web/test/the-staff-first-pages.test.mjs` (new).
**Produces:** `pageBusinessFor(v: { known: boolean; isOperator: boolean; mySlug: string | null }, chosen: BusinessSlug | null, fallback: BusinessSlug): { business: BusinessSlug; ready: boolean }`; `usePageBusiness(fallback: BusinessSlug): { business: BusinessSlug; ready: boolean; setBusiness: (s: BusinessSlug) => void; isOperator: boolean }`.
- [ ] Failing tests: not known → `{fallback, ready:false}`; operator → chosen ?? fallback, ready; employee → own slug, ready, ignores chosen; employee without slug → fallback, ready. Pages: call `usePageBusiness(`, no `useState<BusinessSlug>(` business, load effect starts `if (!ready) return;`; procedures renders `{ready ? <PhrasesSection business={business} /> : null}`; customers renders `ImportCustomers` only when ready.
- [ ] Run → FAIL; implement; run → PASS; commit `fix(staff): Customers, Knowledge, Answer rules and Forecast open on the staff member's own business`.

### Task 2: Knowledge and Answer rules — list first, forms folded, slim counters
**Files:** `knowledge/page.tsx`, `knowledge/knowledge.css`, `procedures/page.tsx`, `procedures/procedures.css`; the test file.
- [ ] Failing tests: Knowledge has `<AddFold label="Teach it something"`, the list (`kn-list`) comes before the fold in the source, `?add=1` opens it (`get("add") === "1"`), a successful add calls `setAdding(false)`. Answer rules: `<AddFold label="Write one yourself"`, save closes it; counts wrapped `{loadError ? null : (` before `pr-counts`; CSS `.pr-count` is a pill (`border-radius: var(--r-pill)`, `font-size: 15px` strong).
- [ ] Run → FAIL; implement; run → PASS; commit `feat(ux): Knowledge and Answer rules show their list first; forms wait behind a button`.

### Task 3: My clients — ⓘ header, the book first, phone rows
**Files:** `my-clients/page.tsx`, `my-clients/my-clients.css`; the test file.
- [ ] Failing tests: `<PageHead` with title "My clients"; in the source `className="mc-book"` comes before `<MyLinkPanel />`; CSS has a `@media (max-width: 640px)` block that turns the book's table rows into blocks (`.mc-book thead` hidden; `tr` display grid).
- [ ] Run → FAIL; implement; run → PASS; commit `feat(ux): My clients puts the book first and fits a phone`.

### Task 4: Customers — denser cards
**Files:** `customers/customers.css`; the test file.
- [ ] Failing tests: CSS pins for the tighter card (`.cu-card` padding ≤ 12px vertical; initials 28px; meta chips one row with `flex-wrap: nowrap` on phones and `overflow: hidden`).
- [ ] Run → FAIL; implement; run → PASS; suite + typecheck; commit `feat(ux): Customers fit twice as many on a phone`.
