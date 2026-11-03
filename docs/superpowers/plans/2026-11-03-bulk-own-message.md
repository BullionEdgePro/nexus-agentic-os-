# Your own message to every chosen customer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** an admin's own message (written by hand or with the AI) goes to all chosen customers in one action, being sent automatically once WhatsApp approves it. The writer never offers a refusal as a draft, and the screen says what the previews and the picker mean.

**Architecture:** campaigns created with the template wait as `scheduled` (no migration). `releaseApprovedCampaigns` in campaign-control releases or fails them after each template sync and on "Check again". The send job refuses to send a campaign that is still `scheduled`. The writer gets a `CANNOT:` rule and returns `{drafts: [], note}`.

**Spec:** `docs/superpowers/specs/2026-11-03-bulk-own-message-design.md`

## Global Constraints
- No migration; no push or deploy without the owner's "Deploy it".
- Copy (exact):
  - `Send for approval, then send to {N} customers` (`customer` when N is 1)
  - `Only send for approval`
  - `Waiting for WhatsApp approval`
  - `Cancel`
  - `As {first} would see it — each customer gets their own name.`
- Tests:
  - API, from `apps/api`: `AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55433/nexus AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55433/nexus node --import tsx --experimental-test-module-mocks --test --test-timeout=60000 test/<file>`. Stand in Redis queues with `mock.module` (no Redis here).
  - Web: `npm --prefix apps/web test`.
  - Typecheck: db, agents, api, web. Then `npx next build` in `apps/web`.
- Comments carry the date `(3 Nov 2026)` in the codebase's style.

## Review Focus
1. Two releases racing (sync job and Check again at once) must queue each recipient once.
2. A campaign whose customers were deleted or opted out between the wait and the approval.
3. A template that comes back APPROVED under a different id or name: release must match by `template_id`.
4. The admin cancelling while the sync releases it.
5. A refusal in Arabic, or a `CANNOT:` with leading spaces or quotes.

---

### Task 1: A refusal is a note, never a draft; the preview says whose view it is
**Files:**
- `apps/api/src/lib/message-writer.ts` (system prompt rule; `writeDrafts` / `rewriteDraft` return `{drafts, note}`)
- `apps/api/src/routes/admin-bulk-writing.ts` (answer `{drafts, note}`)
- `apps/web/lib/api.ts` (types)
- `apps/web/app/deck/bulk/ai-writer.tsx` (render the note; caption above the drafts)

**Tests:**
- `apps/api/test/ai-writes-drafts-not-facts.test.mjs`: add the parse cases.
- `apps/web/test/` new `an-ai-refusal-is-not-a-draft.test.mjs`, a source or render check.

**Steps:**
- [ ] Write the tests and watch them fail.
- [ ] Implement.
- [ ] Run the suites.
- [ ] Commit.

### Task 2: The picker shows the admin's own words
**Files:** `apps/web/app/deck/bulk/page.tsx` (option label via a small exported `templateOptionLabel(name, language)`).
**Test:** web: `bulk_<code>_weekend_viewings` → `Weekend viewings (en)`; `zipicka_order_update` → `zipicka order update (en)`.

### Task 3: Release a waiting campaign when its message is approved
**Files:**
- `apps/api/src/services/campaign-control.ts` (`releaseApprovedCampaigns(organizationId)`, with queueing shared with `resumeCampaign`)
- `packages/db/src/broadcasts.ts` (a query for the waiting campaigns and their template status, if one does not exist)
- `apps/api/src/services/template-sync.ts` (call release after each business)
- `apps/api/src/routes/admin-bulk-templates.ts` (call it in `/templates/refresh`)
- `apps/api/src/queue/broadcast-processor.ts` (`scheduled` is "not yet": throw)

**Test:** a new DB test, `apps/api/test/a-message-goes-out-when-whatsapp-approves.test.mjs`, covering:
- pending → nothing;
- approved → `sending`, and one queued job per recipient (queue stood in);
- a second release → nothing more;
- rejected → `failed`;
- a job for a `scheduled` campaign throws without sending (`fetch` stood in).

### Task 4: One action from the panel; the wait is visible and cancellable
**Files:**
- `apps/api/src/routes/admin-bulk-templates.ts` (`sendTo` → a scheduled campaign plus recipients; answer `waiting`)
- `apps/web/lib/api.ts`
- `apps/web/app/deck/bulk/new-approved.tsx` (the two buttons and the sentence; gets `chosen` from the page)
- `apps/web/app/deck/bulk/page.tsx` (passes `chosen`; the campaigns table shows the waiting label and Cancel, calling the existing stop route)

**Tests:**
- DB: create with `sendTo` (Meta `fetch` stood in) gives a `scheduled` campaign with N pending recipients and nothing queued.
- Web: the button copy appears only with customers chosen; the waiting status label and Cancel are present.
