# The SFS workflow board — design

**Date:** 3 Nov 2026. **Branch:** `sfs-workflow-board`, cut from `sfs-workflow-tab` (`8e5d23f`), which is
not merged yet. **Status:** written under the owner's standing instruction to take Claude's
recommendation at each choice; every choice taken is listed in §13 so it can be overruled.

## 1. What it is for

The owner said the workflow "is real and can control by my staff". The Workflow tab
(`sfs-workflow-tab`) shows what Nexus can measure of the boss's 20 steps. Eleven of the steps have
nothing behind them, because Nexus has no record of units, offers or deals: S5–S10 on the supply lane and
D4, D6–D8 and D10 on the demand lane.

The board gives SFS staff a place to do that work in Nexus:

- every unit SFS is letting or selling, and every serious lead, sits on a step;
- staff move it on as the work happens;
- Nexus records who moved it and when, and keeps the Dubai paperwork beside it.

The owner then sees where every unit and deal stands, and the live picture's empty steps fill with real
records.

**Success:**

- a staff member can add a unit or a lead, move it, fill in what its step needs, and close it, by finger
  on a phone as well as with a mouse;
- no unit can be put into advertising without a valid Trakheesi permit;
- no one sees a colleague's client;
- every figure stays a real record.

## 2. What changes for a person

- **The Workflow panel gets two views:** **Live picture** (today's page) and **Board**. The pills sit
  at the top of the panel, so the switch appears both on `/deck/workflow` and on the HQ Workflow tab.
  The choice is remembered per browser.
- **The board has two lanes, each a row of columns**, one column per step in the boss's order and with
  the boss's names.
  - **Supply.** S1–S4 (Owner database, Data filter, WhatsApp + AI call, Nurture) stay automatic. They
    appear as one narrow strip of live counts from the audit, not as columns you can drop on. Unit cards
    live on S5 Classify unit, S6 Rent units, S7 Sale units, S8 Compliance, S9 Listing & ads and S10
    Portals + social.
  - **Demand.** D1 New lead and D2 AI qualifier stay automatic. D2's strip lists **"Hot leads not on
    the board"**: customers scored high or urgent in the last 30 days for this business (as the serving
    business, the same as the audit's `hot`) who have no open deal. Newest first, at most 20, each with
    **Put on the board**. Deal cards
    live on D3 Cold lead, D4 Unit matcher, D5 Viewing, D6 Offer & negotiation, D7 Rent deal, D8 Sale
    deal and D9 CRM & commission. D10 Daily AI report is an output, not a column.
- **A card** shows:
  - its name: for a unit, its reference (e.g. "Marina Gate 2 · 1204"); for a deal, the lead's name;
  - price or budget in AED, and rent or sale;
  - the agent's initials;
  - **days in this step**;
  - for a deal, the next viewing;
  - warnings: a red **Permit expired** badge on a unit in S9/S10 whose permit has lapsed ("take the
    ads down"), an amber **Permit expires in N days** at 14 days or fewer, and a grey "missing" dot when
    its step's checklist is incomplete.
- **Moving.**
  - Drag a card to another column of its lane, by mouse or by holding a finger, using the kit board's
    pointer drag.
  - Or open the card and use **Move to…**. The menu lists the drawn next steps first ("Next:
    Compliance") and every other step of the lane under "Another step". This route works by keyboard
    and screen reader.
  - A move that breaks a rule (§3) is never offered as a drop target. If one reaches the server anyway,
    the card stays where it was and the reason is shown.
- **The card window** (the kit's card window, as the step window today) shows:
  - the card's fields for editing;
  - **What this step needs**, a checklist (§6) with each item ticked or missing;
  - the matched units or interested deals;
  - its **history** ("Moved to Compliance by Aisha · 2 h ago");
  - **Close**: for a unit, Let, Sold or Withdrawn; for a deal, Won or Lost, with an optional note.
- **Adding.**
  - **Add unit** opens on S5 with a reference and an optional owner, chosen from the viewer's customers.
  - **Add lead** picks a customer from the viewer's own book. Rent or buy is required. It starts on D4,
    or on D3 if chosen.
  - **Put on the board** does the same from the hot list.
- **The board's header shows "Closed in the last 30 days"**: units let, units sold, deals won, and
  commission in AED. The figures come from the closed cards. The Board view hides the period pills,
  because its header is always the last 30 days and its cards are always the open ones. It keeps
  "Updated … ago" and Refresh.
- **Days in step** counts whole days since the card entered its step, and reads "today" under one day.
- **"Waiting longest"** lists the three open cards that have sat longest in one step, each with its days.
  Opening one opens the card.
- **On a phone** each lane scrolls sideways inside itself, and the page never does. A finger hold
  starts a drag, a swipe scrolls, and Move to… is always there.

## 3. Rules

These are written once in `@nexus/shared` (§6), so the board never offers a move that the API refuses.

- **Lanes.** A unit moves only among S5–S10, and a deal only among D3–D9. Any column of its own lane is
  allowed, backwards included, because corrections happen. The history keeps every move.
- **Classifying a unit.** Dropping a unit on **Rent units** makes it a rental, and dropping it on
  **Sale units** makes it a sale; that is what Classify unit means on the drawing. Moving between S6
  and S7 reclassifies it, and the history says so. A unit that was never classified cannot go to
  S8–S10: "Classify it first: put it on Rent units or Sale units."
- **A deal's purpose** (rent or buy) is set when it is added, because the lead says which. Rent deal
  takes only rentals ("Rent deal is for tenancies. This lead is buying.") and Sale deal only purchases
  ("Sale deal is for purchases. This lead is renting.").
- **The advertising gate.** This is the one hard compliance rule. Dubai forbids advertising a property
  without a valid permit, so a unit may enter **S9 Listing & ads** or **S10 Portals + social** only with
  all of these:
  - a Form A signed date;
  - a Trakheesi permit number;
  - a permit expiry date on or after today in the business's timezone.

  The refusal names what is missing: "Before it can be advertised: Trakheesi permit number, permit
  expiry date."
- **Closing.**
  - A unit closes as Let only if it is a rental, as Sold only if it is a sale, and as Withdrawn always.
  - A deal closes as Won only from D7, D8 or D9, and as Lost from anywhere.
  - A closed card leaves the board and is never reopened. A lead can be put on the board again, which
    starts a new deal.
  - Nothing is deleted.
- **Two people at once.** A move carries the step it starts from. If the card has moved since, the
  answer is 409 "Someone moved this card to Viewing a moment ago." and the board reloads. Field edits
  save only the fields sent; the last save wins.
- **Who sees what.** This follows the existing rule: a staff member's clients are the customers in
  their book (`contacts.owner_employee_id`).
  - **Units** are the business's inventory, so every staff member of the business sees and works every
    unit. The owner's name shows only to someone who may see that customer; others see "Owner: with
    {agent}".
  - **Deals:** a staff member sees the deals whose lead is in their book or which are assigned to them.
    Each column also says "+N with colleagues", a count with no names. Operators see everything.
  - **"View as staff"** narrows the scope in the API and carries no staff ID, because the owner is not
    on the staff. It therefore shows the units, the "+N with colleagues" counts and no deals, which is
    honest, as on the other "mine" screens. It is look-only: every write answers 403 "Viewing as staff
    is look-only here.", so no change is ever credited to nobody.
  - The hot list shows a staff member their own book only.
- **A business without a drawn workflow** has no board. Its endpoints answer 404 "This business has no
  workflow."

## 4. Data: migration 107

`packages/db/migrations/107-the-workflow-board.sql` is applied by hand as the owner role before the code
that uses it.

**Rules for every table:**

- each has `organization_id uuid not null references organizations(id) on delete cascade`;
- each uses the standard tenant policy (USING and WITH CHECK on `app.current_org`, or
  `app.tenant_scope = 'all'`), as in 101;
- each has `created_at` and `updated_at` where rows change.

**`property_units`**

- **`step`:** text, `S5`–`S10`.
- **`in_step_since`:** timestamptz, default `now()`.
- **Description:**
  - `reference` text, not empty;
  - `community` text;
  - `property_type`: apartment, villa, townhouse, penthouse, office, shop, warehouse, land or other;
  - `bedrooms` smallint, 0 = studio;
  - `purpose`: rent or sale;
  - `price_aed` numeric(14,2), the yearly rent or the asking price;
  - `cheques` smallint, 1–12.
- **Paperwork:**
  - `ejari_ready`, `title_deed`, `owner_docs`: booleans, default false;
  - `form_a_signed_on` date;
  - `permit_number` text;
  - `permit_expires_on` date;
  - `live_on` text[]: a subset of bayut, dubizzle, property_finder, meta, tiktok.
- **People:**
  - `owner_contact_id`, references contacts, on delete set null;
  - `agent_employee_id`, references employees, on delete set null;
  - `created_by_employee_id`, `created_by_admin_id`, `updated_by_employee_id`,
    `updated_by_admin_id`;
  - `notes`.
- **Closing:** `closed_at`, and `closed_reason` (let, sold or withdrawn), both set or both null.
- **Checks:**
  - S6 means rent and S7 means sale;
  - S8–S10 need a purpose;
  - S9–S10 need `form_a_signed_on`, `permit_number` and `permit_expires_on` to be present. The expiry
    being in the future is checked by the API, because it depends on the date.
- **Index:** `(organization_id, step) where closed_at is null`.

**`property_deals`**

- **Lead and step:**
  - `contact_id`, references contacts, on delete cascade, as bookings do;
  - `step`: `D3`–`D9`;
  - `in_step_since`;
  - `purpose`: rent or sale, not null.
- **Money:** `budget_aed`, `offer_aed`, `deal_value_aed`, `commission_aed`, all numeric(14,2).
- **Paperwork:** `ejari_number` text; `kyc_done` boolean; `form_f_signed_on` date; `dld_transfer_on`
  date.
- **People and notes:** agent, created/updated by, and notes, as for units.
- **Closing:** `closed_at`, and `closed_reason` (won or lost).
- **Checks:** D7 means rent and D8 means sale.
- **Unique:** one open deal per lead and purpose, `(organization_id, contact_id, purpose) where
  closed_at is null`. This also stops two people putting the same hot lead on the board at once; the
  second gets 409 "This lead is already on the board."

A deal may point to a customer whom SFS serves on a shared number but does not own. The foreign key
allows this. Before linking, the API checks that SFS can read the contact under its own tenant scope.

**`property_deal_units`** links a deal to the units offered to it (D4):

- `deal_id` and `unit_id`, each on delete cascade;
- `added_at`, and who added it;
- primary key `(deal_id, unit_id)`.

**`workflow_moves`** is append-only history:

- `unit_id` or `deal_id`, exactly one of them;
- `kind`: created, moved or closed;
- `from_step` (null when created), `to_step` (null when closed);
- `closed_reason`;
- `by_employee_id` or `by_admin_id`;
- `at`.
- Index: `(organization_id, at)`.

**Grants to `nexus_app`:**

- `select, insert, update` on units and deals, with no delete: cards close, they are never deleted;
- `select, insert, delete` on `property_deal_units`, so a matched unit can be unlinked;
- `select, insert` on `workflow_moves`.

The next migration after this one is 108.

## 5. Database module

`packages/db/src/workflow-board.ts` runs every read and write inside `withTenant` for the business.
Each write also inserts its `workflow_moves` row in the same transaction.

- `getBoard({ organizationId, viewer })` → `{ units, deals, hidden, hotWaiting, closed30 }`:
  - `viewer` is `{ employeeId: string | null; seesAll: boolean }`. An operator has `seesAll` true. A
    staff member has their `employeeId`. View as staff has neither, so no deal is in that viewer's book;
  - every write takes an `actor` of `{ employeeId }` or `{ adminId }`;
  - `hidden` is the count per step of deals the viewer may not see.
- `createUnit`, `updateUnit`, `moveUnit`, `closeUnit`.
- `createDeal`, `updateDeal`, `moveDeal`, `closeDeal`.
- `linkUnit(dealId, unitId)` and `unlinkUnit(dealId, unitId)`.
- `cardHistory`.
- A move updates `where id = $1 and step = $from and closed_at is null`. Zero rows answers `moved`,
  with the current step, or `closed`.

## 6. Shared rules: `packages/shared/src/workflows/board.ts`

- `boardColumns(workflow, lane)` → the card columns: S5–S10 and D3–D9.
- `automaticSteps(workflow, lane)` → S1–S4 and D1–D2.
- `moveProblem(card, to, today)` → `string | null`, using the exact refusal copy in §3. The web's
  `canDrop` and the API's 422 both call it.
- `closeProblem(card, reason)` → `string | null`.
- `stepNeeds(card)` → `{ label, done }[]`, the checklist for the card's current step:
  - S5: reference, type, bedrooms, price;
  - S6: cheques, Ejari-ready;
  - S7: title deed, owner documents;
  - S8: Form A, permit number, expiry;
  - S9: the S8 items;
  - S10: live on at least one portal;
  - D4: at least one unit matched;
  - D5: a viewing booked;
  - D6: offer amount;
  - D7: Ejari number;
  - D8: KYC, Form F, DLD transfer;
  - D9: deal value, commission.
- `permitState(unit, today)` → `"ok" | "expiring" | "expired" | "none"`, where expiring means 14 days
  or fewer.
- `nextSteps(workflow, stepId)` → the drawn arrows, which order the Move to… menu.

## 7. API

All routes are mounted under `/api/organizations/:slug`, behind `requireTenantScope`. Staff reach their
own business only and operators reach any business. The routes 404 when `workflowFor(slug)` is null.

| Method and path | Answer |
|---|---|
| `GET /:slug/workflow-board` | the board (§5) |
| `POST /:slug/workflow-board/units` | the new unit, 201 |
| `PATCH /:slug/workflow-board/units/:id` | the unit; 409 if closed |
| `POST /:slug/workflow-board/units/:id/move` `{ from, to }` | the unit; 409 if moved or closed; 422 with the refusal |
| `POST /:slug/workflow-board/units/:id/close` `{ reason, note? }` | 200; 422 with the refusal |
| the same four routes under `/deals` | as for units; creating answers 409 when the lead is already on the board |
| `POST /:slug/workflow-board/deals/:id/units` `{ unitId }`, `DELETE …/units/:unitId` | the deal |
| `GET /:slug/workflow-board/:kind/:id/history` | the moves, with names |

- **Input checks answer 400:** unknown fields are ignored; numbers must be zero or more; dates must be
  ISO; `live_on` must be a subset of its list; steps must be in their lane.
- **A card the viewer may not see answers 404**, exactly like a card that does not exist.
- **Who acted:** `employeeId`, or `adminId` for an operator, is taken from the session scope, never from
  the request body. A scope with neither (View as staff) gets 403 on every write.

## 8. The live picture

`evidence` gains `board: Record<string, number>`: for each step, how many cards were created on it or
moved into it in the period. `getWorkflowAudit` reads it from `workflow_moves` in the business's
timezone. The step definitions change as follows:

- **S5–S10, D4, D6, D7 and D8** become `built`. Their activity is `board[step]`, and their `does` line
  reads "Units moved into this step on the board in the period." or "Deals moved …". Their `missing`
  becomes null.
- **D9** becomes `built`. Its activity is follow-ups created + done + `board.D9`, and "Commission."
  is no longer missing.
- **D10** stays not tracked.
- **S1–S4, D1–D3 and D5** keep the measures they have.

The Pulse, the verdict, the tiles and `isQuiet` pick this up with no further change. `isQuiet` adds the
board counts to its list of period activity. Before staff use the board, the newly built steps honestly
show as **idle**.

## 9. Web

- **`apps/web/lib/api.ts`:** the board's types and a call per endpoint.
- **`apps/web/app/deck/workflow/board/`:**
  - `board-view.tsx`: the lanes, the strips, the columns and the header;
  - `board-card.tsx`;
  - `card-detail.tsx`: the card window;
  - `add-card.tsx`: Add unit and Add lead, with the customer search from the existing contacts endpoint;
  - `move-menu.tsx`.
- **Reuse:** columns and cards use the kit's `BoardColumn`, `BoardCard` and `useBoardDrag`.
  `canDrop` calls `moveProblem`; `onDrop` calls the API and the board then shows what the server saved.
- **States:** the same as the panel:
  - a loading outline marked `aria-busy`;
  - an error with Try again;
  - Refresh that keeps the cards;
  - a late answer is dropped;
  - a refused move leaves the card where it was and shows the reason in a `role="status"` line;
  - a 409 reloads the board.
- **Styles** go in `workflow.css` with `wf-board-` class names, checked first for clashes. Components
  import no CSS.

## 10. Not in this piece

- AI matching. D4's "sends 3 best-fit units" stays a person linking units.
- Sending anything to an owner or a customer. Moves only record.
- Syncing with the portals (Bayut, Dubizzle, Property Finder), photo or document uploads, and ad spend.
- Commission splits between agents.
- Reopening a closed card.
- The daily report (D10).
- Cards for S1–S4 and D1–D2. Those steps are automatic.

## 11. Testing

- **Shared:** every rule in §3 and every checklist in §6, including permits expiring today, yesterday
  and in 14 days, and a reclassification.
- **Database** (needs Docker; no Redis, so `lib/pubsub.ts` is mocked as before):
  - business A cannot read, move or link business B's cards;
  - `workflow_moves` cannot be updated or deleted;
  - the check constraints reject S9 without a permit and S7 with a rental;
  - the one-open-deal unique index holds;
  - a move from the wrong step answers `moved`.
- **API:**
  - 404 for a business without a workflow;
  - a staff member's 404 for a colleague's deal, and "+N with colleagues" counted;
  - 422 for the advertising gate and for a mismatched purpose;
  - 409 for a race;
  - who acted is taken from the session;
  - an operator sees everything.
- **Audit:** board moves count on their step within the period and not outside it; the newly built
  steps are idle with no moves.
- **Web:**
  - the columns and strips render;
  - the badges show for an expired permit, an expiring permit and days in step;
  - the Move to… menu orders the drawn steps first;
  - a refused move shows its reason;
  - the 409 path reloads.
- **Preview** against the mock API, desktop and phone.

## 12. Deploy

This deploys only after the owner says "Deploy it", and after `sfs-workflow-tab`.

1. On the VPS, run `git pull`.
2. Back up the database.
3. Apply 107 with `psql -v ON_ERROR_STOP=1`.
4. Run `schema-drift-check`.
5. Run `deploy.sh`.

No new settings are needed.

## 13. Choices taken under the standing instruction

Each line is the recommendation taken, then the alternative that was set aside.

1. **What a card is:** a unit on the supply lane and a deal on the demand lane. Set aside: one generic
   card table with free-form fields. That would be weaker for D4 matching and could not enforce the
   permit gate in the database.
2. **Moves only record.** Set aside: moves that send messages or create tasks. Those are outward actions,
   so they belong in a later piece.
3. **Any column of a card's own lane**, plus the two purpose rules and the one hard gate. Set aside:
   only along the drawn arrows, which would make corrections impossible.
4. **Classifying is the drop on Rent units or Sale units.** Set aside: a rent/sale field that S6 and S7
   check. That adds a refusal for no gain.
5. **Deals follow the "own book" privacy rule; units are shared.** Set aside: a fully shared team board,
   which would show colleagues' clients.
6. **S1–S4 and D1–D2 stay automatic strips,** with a hot-leads list that bridges into the board. Set
   aside: a card for every contact, which would flood the board.
7. **Drag by finger or mouse with the kit board, plus a Move to… menu.** Set aside: drag only, which
   cannot be used by keyboard and is awkward on phones.
8. **The board feeds the live picture.** S5–S10, D4, D6–D9 become built from board moves. Set aside:
   keeping the two apart, which would leave the picture's empty steps empty forever.
