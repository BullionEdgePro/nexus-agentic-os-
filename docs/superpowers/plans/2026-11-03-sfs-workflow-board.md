# The SFS workflow board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SFS staff move units (S5–S10) and deals (D3–D9) through the boss's workflow on a board in the
Workflow panel. Nexus records who moved what and when, enforces the Dubai advertising permit, and feeds
the live picture.

**Architecture:**
- One rules module in `@nexus/shared` is used by both the web `canDrop` and the API's 422.
- Migration 107 adds four tenant-scoped tables.
- `packages/db/src/workflow-board.ts` reads and writes them inside `withTenant`, writing the move
  history in the same transaction.
- A Hono route under `/api/organizations/:slug` serves them.
- The web board reuses the kit board's pointer drag.

**Tech Stack:** Next.js 14, React, Hono, Postgres with RLS, node:test with tsx.

**Spec:** `docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md`

## Global Constraints

- **Setup:** run `npm ci` once at the worktree root before Task 1.
- **Tests:**
  - API, shared and DB: `npm --prefix apps/api test`;
  - web: `npm --prefix apps/web test`;
  - types: `npm run typecheck` at the root;
  - build: `npx next build` in `apps/web`, with no dev server running.
- **Real-database cases** run only when `AUDIT_TEST_OWNER_URL` and `AUDIT_TEST_APP_URL` are set: the
  throwaway Postgres on port 55433, with Docker started first. Each such file:
  - takes `pg_advisory_lock(20261102)`;
  - applies its own migration file as the owner;
  - seeds with its own UUIDs;
  - reads as `nexus_app`;
  - mocks `lib/pubsub.ts` if anything it calls reaches `publishInboxEvent`, because there is no Redis.
- **The migration is safe to run twice:** `create table if not exists`, `drop policy if exists` before
  each `create policy`, and `create index if not exists`.
- **Exact copy (spec §3):**
  - "Classify it first: put it on Rent units or Sale units."
  - "Before it can be advertised: {items}." The items, in this order: "Form A signed date",
    "Trakheesi permit number", "permit expiry date", "a permit that has not expired (it expired on
    {D Mon YYYY})".
  - "Rent deal is for tenancies. This lead is buying."
  - "Sale deal is for purchases. This lead is renting."
  - "Someone moved this card to {step name} a moment ago."
  - "This card is closed."
  - "This lead is already on the board."
  - "This business has no workflow."
  - "Viewing as staff is look-only here."
  - "+{N} with colleagues"
  - "Hot leads not on the board"
  - "Put on the board"
  - "Closed in the last 30 days"
  - "Waiting longest"
  - "Permit expired"
  - "Permit expires in {N} days"
  - "Move to…"
  - "Another step"
  - "What this step needs"
  - "Live picture"
  - "Board"
- **Components import no CSS.** Board classes start `wf-board-`. Grep `workflow.css`, `kit.css` and
  `hq.css` for each new class before using it.
- **Who acted** always comes from `c.get("scope")`, never from a request body.
- **Commits** are local only, end with the attribution line, and are never pushed.

## Review Focus

1. **A permit that lapses while the unit is advertised.** The next day the card must say "Permit
   expired" with nobody touching it. "Today" is the business's date from the server, not the browser
   clock. Task 3 and Task 6 test this.
2. **A customer moved to another staff member's book after their deal exists.** Visibility follows the
   book at read time: the old agent stops seeing the deal unless it is assigned to them. Task 3 tests
   this.
3. **A shared-number customer.** A customer whom SFS serves but another business owns can go on the
   board and their name shows. A contact SFS cannot read answers 404. Tasks 3 and 4 test this.
4. **Money typed as "1,200,000".** The form strips commas and spaces before sending. The API answers 400
   to anything that is not a number ≥ 0. Tasks 4 and 7 test this.
5. **A drop on an automatic strip or the other lane.** It sends no request and the card stays. Task 6
   tests this.

---

### Task 1: Board rules in `@nexus/shared`

**Files:**
- Create: `packages/shared/src/workflows/board.ts`.
- Modify: `packages/shared/src/workflows/index.ts`, adding `export * from "./board.js"`.
- Test: `apps/web/test/the-board-rules.test.mjs`.

**Interfaces:**

- **Produces, types:**
  - `UnitStep = "S5"|"S6"|"S7"|"S8"|"S9"|"S10"`;
  - `DealStep = "D3"|…|"D9"`;
  - `Purpose = "rent"|"sale"`;
  - `Portal = "bayut"|"dubizzle"|"property_finder"|"meta"|"tiktok"`;
  - `PropertyType` (spec §4 list);
  - `UnitClose = "let"|"sold"|"withdrawn"` and `DealClose = "won"|"lost"`;
  - `BoardUnit`: `{ kind: "unit"; id; step: UnitStep; inStepSince: string; reference; community;
    propertyType; bedrooms; purpose: Purpose|null; priceAed; cheques; ejariReady; titleDeed;
    ownerDocs; formASignedOn; permitNumber; permitExpiresOn; liveOn: Portal[]; owner: { contactId;
    name: string|null } | null; agent: { id; name } | null; notes; dealIds: string[] }`. Dates are
    `YYYY-MM-DD` strings, and `owner.name` is null when the viewer may not see that customer;
  - `BoardDeal`: `{ kind: "deal"; id; step: DealStep; inStepSince; contact: { id; name }; purpose:
    Purpose; budgetAed; offerAed; ejariNumber; kycDone; formFSignedOn; dldTransferOn; dealValueAed;
    commissionAed; agent; notes; unitIds: string[]; nextViewingAt: string|null }`;
  - `BoardCard = BoardUnit | BoardDeal`;
  - `Board`: `{ units; deals; hidden: Partial<Record<DealStep, number>>; hotWaiting: { contactId;
    name; priority: "high"|"urgent"; scoredAt }[]; closed30: { let; sold; won; commissionAed };
    today: string }`;
  - `CardMove`: `{ kind: "created"|"moved"|"closed"; from: string|null; to: string|null;
    closedReason: string|null; by: string|null; at: string }`.
- **Produces, functions:**
  - `UNIT_STEPS` and `DEAL_STEPS`, readonly arrays;
  - `boardColumns(workflow, lane): WorkflowStep[]`;
  - `automaticSteps(workflow, lane): WorkflowStep[]`;
  - `nextSteps(workflow, stepId): string[]`;
  - `purposeAfterMove(unit, to): Purpose|null`;
  - `moveProblem(card, to, today): string|null`;
  - `closeProblem(card, reason): string|null`;
  - `stepNeeds(card): { label: string; done: boolean }[]`;
  - `permitState(unit, today): "ok"|"expiring"|"expired"|"none"`;
  - `daysInStepLabel(inStepSince: string, now: number): string`, giving "today", "1 day" or
    "N days".

- [ ] **Step 1: Write the failing tests.** Fixture builders `unit(over)` and `deal(over)` with today
  `"2026-11-03"`. Assertions:
  - `boardColumns(REAL_ESTATE_WORKFLOW, "supply").map(s => s.id)` deep-equals `["S5", …, "S10"]`;
  - `boardColumns(…, "demand")` gives `["D3", …, "D9"]`;
  - `automaticSteps` gives `["S1"…"S4"]` and `["D1", "D2"]`;
  - `nextSteps(…, "S5")` gives `["S6", "S7"]`;
  - `purposeAfterMove(unit({ purpose: "sale" }), "S6")` is `"rent"`;
  - `moveProblem(unit({ purpose: null }), "S8", today)` is the classify copy;
  - `moveProblem(unit({ purpose: null }), "S6", today)` is null;
  - `moveProblem(unit({ purpose: "rent" }), "S9", today)` is "Before it can be advertised: Form A
    signed date, Trakheesi permit number, permit expiry date.";
  - with all three set and an expiry of `"2026-11-02"` → "Before it can be advertised: a permit that
    has not expired (it expired on 2 Nov 2026).";
  - an expiry of `"2026-11-03"` → null (today still counts);
  - `moveProblem(deal({ purpose: "sale" }), "D7", today)` and `(deal({ purpose: "rent" }), "D8",
    today)` give the two deal copies;
  - a move to its own step → "It is already on this step.";
  - a unit to `"D4"` → "That step is not on this card's lane.";
  - `closeProblem`:
    - `(unit({ purpose: "sale" }), "let")` → "Only a unit to let can close as Let.";
    - `(deal({ step: "D5" }), "won")` → "A deal closes as Won from Rent deal, Sale deal or CRM &
      commission.";
    - `(deal({ step: "D9" }), "won")` → null;
  - `stepNeeds(unit({ step: "S8", formASignedOn: "2026-10-01" }))` gives labels `["Form A signed",
    "Trakheesi permit number", "Permit expiry"]` with done `[true, false, false]`;
  - `stepNeeds(deal({ step: "D4", unitIds: [] }))` is `[{ label: "At least one unit matched", done:
    false }]`;
  - `permitState` at expiries `"2026-11-02"`, `"2026-11-17"`, `"2026-11-18"` and none gives
    `"expired"`, `"expiring"`, `"ok"` and `"none"`;
  - `daysInStepLabel` at 3 h, 26 h and 50 h ago gives "today", "1 day" and "2 days".
- [ ] **Step 2: Run** `npm --prefix apps/web test`. Expect FAIL: the exports are missing.
- [ ] **Step 3: Implement** `board.ts`. Dates compare as `YYYY-MM-DD` strings. The "D Mon YYYY" format
  uses `en-GB` with `timeZone: "UTC"` on the date at noon UTC.
- [ ] **Step 4: Run** the web suite and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit:** `Board rules: lanes, the advertising gate, purposes, checklists`.

### Task 2: Migration 107, the tables

**Files:**
- Create: `packages/db/migrations/107-the-workflow-board.sql`.
- Test: `apps/api/test/the-workflow-board-tables.test.mjs`.

**Interfaces:** Produces the tables `property_units`, `property_deals`, `property_deal_units` and
`workflow_moves`, with the columns, checks, unique index, policies and grants of spec §4.
`workflow_moves` has a check that exactly one of `unit_id` and `deal_id` is set and exactly one of
`by_employee_id` and `by_admin_id` is set.

- [ ] **Step 1: Write the failing tests.**
  - **Source checks, always run:**
    - every table has `enable row level security` and a policy using `app.current_org` with both USING
      and WITH CHECK;
    - there is no `delete` grant on `property_units` or `property_deals`;
    - `workflow_moves` is granted `select, insert` only.
  - **Real-database cases:** seed two businesses, SFS and OTHER, each with a contact and an employee.
    As `nexus_app` with `app.current_org` = OTHER:
    - SFS's unit is invisible;
    - inserting a unit with SFS's `organization_id` fails;
    - inserting an S9 unit without a permit fails with a check violation;
    - an S7 unit with `purpose = 'rent'` fails;
    - a second open deal for the same contact and purpose fails with a unique violation; one with the
      other purpose succeeds;
    - `update workflow_moves` and `delete from workflow_moves` fail with a permission error;
    - `delete from property_units` fails with a permission error.
- [ ] **Step 2: Run** `npm --prefix apps/api test`. Expect FAIL: the file is missing. With the DB env
  set, the DB cases fail too.
- [ ] **Step 3: Write the migration**, with a header comment in the style of 101 that names the spec.
- [ ] **Step 4: Run** the API suite, with the DB env set when Docker is up. Expect PASS. Run it twice
  in a row to prove the migration is safe to re-run.
- [ ] **Step 5: Commit:** `Migration 107: units, deals, matched units and the move history`.

### Task 3: The board's records (`packages/db/src/workflow-board.ts`)

**Files:**
- Create: `packages/db/src/workflow-board.ts`.
- Modify: `packages/db/src/index.ts` (export it).
- Test: `apps/api/test/the-workflow-board-records.test.mjs`.

**Interfaces:**
- **Consumes** the Task 1 types and `moveProblem`, `closeProblem` and `purposeAfterMove`.
- **Produces:**
  - `Viewer = { employeeId: string|null; seesAll: boolean }`;
  - `Actor = { employeeId: string } | { adminId: string }`;
  - `getBoard(input: { organizationId; timezone; viewer }): Promise<Board>`;
  - `createUnit(orgId, actor, fields): Promise<BoardUnit>`;
  - `updateUnit(orgId, actor, viewer, id, fields): Promise<BoardUnit | "closed" | null>`;
  - `moveUnit(orgId, timezone, actor, viewer, id, from, to)` and `moveDeal(…)`. Each returns
    `{ ok: card } | { moved: string } | { closed: true } | { refused: string } | null`;
  - `closeUnit(orgId, actor, viewer, id, reason, note)` and `closeDeal(…)`, returning
    `{ ok: true } | { refused: string } | { closed: true } | null`;
  - `createDeal(orgId, actor, viewer, fields): Promise<BoardDeal | "duplicate" | "no-contact">`;
  - `updateDeal(…)`;
  - `linkUnit(orgId, actor, viewer, dealId, unitId)` and `unlinkUnit(…)`;
  - `cardHistory(orgId, viewer, kind: "unit"|"deal", id): Promise<CardMove[] | null>`.
- **Rules:**
  - null means not found or not visible;
  - a deal is visible when `viewer.seesAll`, or the contact's `owner_employee_id` equals
    `viewer.employeeId`, or the deal's `agent_employee_id` equals `viewer.employeeId`;
  - `today` is `(now() at time zone $timezone)::date`.

- [ ] **Step 1: Write the failing tests.**
  - **Source checks:** every exported function calls `withTenant(`; every write inserts into
    `workflow_moves` in the same callback; the move's update has `and step = $` and `closed_at is
    null`.
  - **Real-database cases** (seed SFS with staff A and B, contacts in A's and B's books, a contact owned
    by OTHER with an SFS-routed conversation, and a hot score for A's contact):
    1. **Own book.** A's `getBoard` lists A's deal, not B's, and `hidden` counts B's deal on its step.
       `seesAll` lists both. A unit whose owner is in B's book is listed for A with `owner.name` null
       and `agent` set, and for B with the owner's name.
    2. **The book changes.** Moving A's contact to B's book (`update contacts set owner_employee_id`)
       hides the deal from A, unless the deal's agent is A.
    3. **Hot list.** A's contact shows in `hotWaiting` until A creates a deal for it.
    4. **Race.** `moveUnit(…, from: "S5", to: "S6")` then the same call again answers `{ moved: "S6" }`.
       The first move set `purpose = 'rent'` and `in_step_since` to now, and wrote one `moved` row with
       `by_employee_id` = A.
    5. **Gate.** A move to S9 without a permit answers `{ refused: "Before it can be advertised: …" }`
       and writes nothing.
    6. **Lapsed permit.** A unit in S9 with an expiry before today in Dubai is still listed, and
       `board.today` is the Dubai date.
    7. **Duplicate deal.** `createDeal` for the same contact and purpose answers `"duplicate"`.
    8. **Shared-number customer.** A deal for OTHER's routed contact is created and its name is shown.
       A contact of an unrelated business answers `"no-contact"`.
    9. **Closing.** `closeDeal(…, "won")` from D5 answers `{ refused }`. From D9 it answers `ok`, and
       `closed30` counts the win and its commission.
    10. **History.** `cardHistory` returns `created`, `moved` and `closed` in order, with names.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
  - The refusal is computed with `moveProblem` against the row read `for update` inside the transaction.
  - On a move, `in_step_since = now()`, and the purpose comes from `purposeAfterMove`.
  - `nextViewingAt` is the earliest confirmed booking for the contact at or after now.
- [ ] **Step 4: Run** the API suite, with the DB env set when Docker is up, and the typecheck. Expect
  PASS.
- [ ] **Step 5: Commit:** `Board records: read by book, move once, refuse what the rules refuse`.

### Task 4: The API route

**Files:**
- Create: `apps/api/src/routes/workflow-board.ts`.
- Modify: `apps/api/src/index.ts`, adding `app.route("/api/organizations", workflowBoardRoute)` after the
  tenant guard and next to `workflowAuditRoute`.
- Test: `apps/api/test/the-workflow-board-door.test.mjs`.

**Interfaces:**
- **Consumes** Task 3.
- **Produces** the routes of spec §7, plus `parseUnitFields(body)` and `parseDealFields(body)`. Each
  returns `{ fields } | { error: string }`: unknown keys are dropped, money must be finite and ≥ 0
  (numbers or numeric strings without commas), dates must be `YYYY-MM-DD`, and `liveOn` must be a subset
  of `Portal`.
- **Status codes:** 201 for a create; 404 for no workflow, a card not found, or `no-contact`; 409 for
  moved, closed or duplicate; 422 with `{ error }` for a refusal; 403 for a write with neither
  `employeeId` nor `adminId`.

- [ ] **Step 1: Write the failing tests.** Mock `@nexus/db` with every export the route imports, as
  `knowledge-routes.test.mjs` does. Mount behind a tiny app that sets `scope`. Cases:
  - `GET /zipicka/workflow-board` → 404 "This business has no workflow.";
  - a staff scope's move answering `{ moved: "D5" }` → 409 "Someone moved this card to Viewing a moment
    ago.";
  - `{ refused }` → 422 with that text;
  - `"duplicate"` → 409 "This lead is already on the board.";
  - `"no-contact"` → 404;
  - a history stub answering null → 404, the same answer as a card that does not exist;
  - a scope `{ role: "employee" }` with no `employeeId` POSTing → 403 "Viewing as staff is look-only
    here.";
  - the actor passed to the db stub is `{ employeeId }` from the scope, even when the body carries
    `employeeId`;
  - `parseUnitFields({ priceAed: "1,200,000" })` → error; `{ priceAed: "1200000" }` → 1200000;
    `{ priceAed: -1 }` → error; `{ liveOn: ["bayut", "x"] }` → error;
  - source check: the mount sits after `app.use("/api/organizations/:slug/*", requireTenantScope)`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** The organization comes from `findOrganizationBySlug`. The step name in the
  409 copy comes from `REAL_ESTATE_WORKFLOW`.
- [ ] **Step 4: Run** the API suite and the typecheck. Expect PASS.
- [ ] **Step 5: Commit:** `Board door: one route under the tenant guard, who acted from the session`.

### Task 5: The live picture reads the board

**Files:**
- Modify: `packages/shared/src/workflows/types.ts` (`evidence.board: Record<string, number>` and
  `evidence.permits: { advertised: number; expired: number }`).
- Modify: `packages/shared/src/workflows/real-estate.ts` (spec §8).
- Modify: `packages/db/src/workflow-audit.ts`.
- Modify: `apps/web/lib/workflow/pulse.ts` (`isQuiet` adds `Object.values(e.board)`, but not `permits`).
- Modify: `apps/web/app/deck/workflow/compliance.tsx`.
- Tests: `apps/web/test/the-workflow-rules.test.mjs`,
  `apps/api/test/the-workflow-audit-counts-what-happened.test.mjs`,
  `apps/web/test/the-workflow-tab.test.mjs`, and every fixture that builds an `evidence` (grep `withSource:`).

- [ ] **Step 1: Change the tests first.**
  - The coverage counts become `{ built: 15, partly: 4, not_tracked: 1 }`. S8 becomes `"built"` with
    `missing` null. With empty evidence the verdict is `{ working: 0, idle: 15, partly: 4, not_tracked:
    1 }`.
  - S9's activity is `board.S9`. D9's activity is follow-ups created + done + `board.D9`.
  - A quiet fixture with `permits: { advertised: 3, expired: 1 }` and zero board counts is still quiet;
    one with `board: { S8: 1 }` is not.
  - The compliance table renders "On the board: 3 units advertised · 1 with an expired permit". It
    renders "Recorded on each deal on the board" four times. It has no "Tracking it would need".
  - **DB case:** seed `workflow_moves` rows into S8 at Dubai day 1 and day 8. The 7-day audit gives
    `board.S8 = 1`. An S9 unit with a lapsed permit gives `permits = { advertised: 1, expired: 1 }`.
- [ ] **Step 2: Run** both suites. Expect FAIL.
- [ ] **Step 3: Implement.** `board` counts `kind in ('created','moved')` by `to_step` within the
  period, using the audit's existing Dubai bounds. `permits` counts open units in S9 and S10 now. Every
  evidence fixture gains `board: {}` and `permits: { advertised: 0, expired: 0 }`.
- [ ] **Step 4: Run** the web and API suites and the typecheck. Expect PASS.
- [ ] **Step 5: Commit:** `The live picture reads the board: ten steps built, permits in compliance`.

### Task 6: The board view

**Files:**
- Create in `apps/web/app/deck/workflow/board/`: `board-view.tsx`, `board-card.tsx`, `move-menu.tsx`
  and `board-panel.tsx` (the loader).
- Modify: `apps/web/lib/api.ts` (types re-exported from shared; `getWorkflowBoard(slug)`,
  `moveBoardCard(slug, kind, id, from, to)`, and the create, update, close, link and history calls).
- Modify: `apps/web/app/deck/workflow/panel.tsx`, adding the "Live picture" and "Board" pills. The
  choice is kept in localStorage `nexus.workflow.view`, with try/catch.
- Modify: `workflow.css`.
- Test: `apps/web/test/the-workflow-board.test.mjs`.

**Interfaces:**
- **Consumes** Task 1, Task 4's endpoints, and the kit's `BoardColumn`, `BoardCard` and
  `useBoardDrag({ canDrop, onDrop })`.
- **Produces:**
  - `WorkflowBoardView({ workflow, board, audit: WorkflowAudit|null, now, onMove, onOpen, onAdd,
    seesAll })`, a pure render;
  - `WorkflowBoardPanel({ slug })`, which holds the state;
  - `MoveMenu({ workflow, card, today, onMove })`.

- [ ] **Step 1: Write the failing tests**, using `renderToStaticMarkup`:
  - The view renders one `data-column` per card step (S5–S10, D3–D9) and none for S1–S4 or D1–D2. The
    automatic strips show the audit counts.
  - "Hot leads not on the board" lists `hotWaiting` names, each with "Put on the board".
  - "+2 with colleagues" shows on D5 when `hidden.D5 = 2`.
  - A unit in S9 whose expiry is before `board.today` shows "Permit expired". One expiring in 5 days
    shows "Permit expires in 5 days". A card shows `daysInStepLabel`.
  - "Closed in the last 30 days" shows let, sold, won and "AED 84,000".
  - "Waiting longest" lists the three oldest `inStepSince` cards.
  - `MoveMenu` for a unit on S5 lists "Next:" S6 and S7 first, then "Another step" with S8–S10.
    Options whose `moveProblem` is not null are disabled and carry the reason as their title.
  - The board's `canDrop` (exported as `boardCanDrop(workflow, board, cardId, from, to)`) is false for
    S2, for D4 from a unit, and for S9 without a permit.
  - **Source checks on the panel:** a refused move shows the API's text in `role="status"`; a 409
    calls the board's reload; the late-answer `requestId` guard; Refresh keeps the cards; the period
    pills are not rendered when the Board view is on.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** The lanes scroll sideways inside `.wf-board-lane`, and the page never
  does. On a card, the "missing" dot shows when any `stepNeeds` item is not done.
- [ ] **Step 4: Run** the web suite and the typecheck. Expect PASS.
- [ ] **Step 5: Commit:** `Board view: two lanes of steps, drag by finger or mouse, Move to… for everyone`.

### Task 7: The card window and adding

**Files:**
- Create in `apps/web/app/deck/workflow/board/`: `card-detail.tsx` and `add-card.tsx`.
- Modify: `board-panel.tsx`.
- Test: `apps/web/test/the-workflow-board.test.mjs`.

**Interfaces:**
- **Consumes** Tasks 1, 4 and 6.
- **Produces:**
  - `CardDetail({ workflow, card, board, history, onSave, onMove, onClose, onLink, onUnlink })`;
  - `AddCard({ kind, contacts, onSearch, onCreate })`;
  - `toAed(input: string): number | null`, which strips commas and spaces, gives null for empty, and
    gives NaN for non-numbers.

- [ ] **Step 1: Write the failing tests.**
  - `CardDetail` for a deal in D7 shows "What this step needs", with "Ejari number" not done, and lists
    its history lines "Moved to Rent deal by Aisha".
  - The close choices for a sale unit are Sold and Withdrawn; Let is disabled with the
    `closeProblem` text.
  - A unit's owner shows the name, or "Owner: with Aisha" when `owner.name` is null.
  - `AddCard` for a lead requires rent or buy before Save is enabled, and offers D4 (the default) and
    D3.
  - `toAed("1,200,000")` → 1200000; `toAed(" 85 000 ")` → 85000; `toAed("")` → null;
    `Number.isNaN(toAed("85k"))`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** The window is the kit card window, as `StepWindow` uses it. Saving sends
  only the changed fields. Customer search uses `GET /:slug/contacts?q=`.
- [ ] **Step 4: Run** the web suite and the typecheck. Expect PASS.
- [ ] **Step 5: Commit:** `Card window: what the step needs, its history, close; add a unit or a lead`.

### Task 8: Preview and whole-branch checks

**Files:**
- Modify, outside the repo: `C:\CLAUDE CODE\bacora\.claude\nexus-mock\mock-api.mjs`. Add an in-memory
  board for `sfs-international` and the board endpoints with the same answers as Task 4.
- Modify: `C:\CLAUDE CODE\bacora\.claude\launch.json`. Add `nexus-web-wfboard`, on port 3104, from this
  worktree, with its `apps/web/.env.local` pointing at the mock.

- [ ] **Step 1: Check the desktop.** Start the mock and the web app and sign in as admin.
  - Board view: drag a unit S5 → S6 by mouse.
  - Try S8 → S9 without a permit: the card stays and the reason shows.
  - Add the permit and move it.
  - Put a hot lead on the board, move it, and close it as Won from D9.
  - Screenshot.
- [ ] **Step 2: Check the phone,** with the `mobile` preset: a finger-hold drag, Move to…, no sideways
  page scroll. Screenshot. Then sign in as staff `sfs`: a colleague's deal shows only as "+N with
  colleagues".
- [ ] **Step 3: Run the whole branch:** the API and web suites, `npm run typecheck`, and `npx next
  build` (with the dev server stopped). Expect all PASS.
- [ ] **Step 4: Commit any fixes,** each with its failing test first.
