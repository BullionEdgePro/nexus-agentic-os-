# Pocket Listings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff mark a unit as a pocket (off-market) listing and share it privately, one link per buyer on the board, with a public private-listing page that re-checks every rule on each view, view/interest tracking and an agent alert.

**Architecture:** Migration 112 adds `property_units.pocket` and `unit_pocket_shares`. Pure rules in `packages/shared/src/portals/pocket.ts` (matching, message, S10 need). Records in `packages/db/src/pocket-listings.ts` (signed-in writes + token lookups). Board routes in `routes/workflow-board.ts`; public routes in `routes/pocket-public.ts` mounted outside the tenant scope like `/portal-feeds`. Web: a Pocket section on the unit card, a share window, and a public page `app/pocket/[token]`.

**Tech Stack:** Postgres (RLS), Hono, Next.js 14 (app router), node:test + tsx.

**Spec:** docs/superpowers/specs/2026-11-07-pocket-listings-design.md

## Global Constraints

- Migration file `packages/db/migrations/112-a-unit-kept-off-market.sql`; next migration after it is 113.
- Token: `randomBytes(32).toString("base64url")` (43 chars, `^[A-Za-z0-9_-]{43}$`); a malformed token is answered "unavailable" without a database read.
- Share lifetime 14 days; one active share per (unit, deal); view counted at most once per share per 10 minutes.
- Pocket readiness = `portalProblems` (the portals' rule) with the same context as `setUnitPortal` (`listingContext`).
- Matches: deals the viewer can see (`SEES_DEAL`), same purpose, steps D3–D7; `fits` when budget ≥ 0.9 × price.
- Exact copy: spec §2, §4, §5, §6, §7 (quoted in the tasks that render them).
- Public answers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`; the page also sets `robots: { index: false, follow: false }`.
- The page data never has: building, reference, owner, notes, history, the token of another share.
- CRLF files (`apps/api/src/index.ts`, `packages/db/src/index.ts`, `apps/web/lib/api.ts`) are edited with the Edit tool only. Scripts are written with the Write tool (Bash collapses backslashes).

## Review Focus

1. A pocket unit getting a portal switch on (old endpoint, a second tab) → refused, and the feed/PF exclude pocket units anyway (Task 3 tests `a pocket unit's switch cannot go on` + `the feed leaves a pocket unit out even with a switch on`).
2. A link opened after the unit closed, Pocket went off, the permit expired or the share expired/revoked → the one "unavailable" answer (Task 4 test `every rule is checked on every view`).
3. A malformed or guessed token, and the page data → no database read for malformed; no private field ever (Task 4 test `the page never carries what stays private`, Task 5 test `a malformed token is unavailable without a lookup`).
4. Staff sharing a colleague's client → refused (Task 3 test `staff cannot share with a colleague's client`).
5. Refresh and button spam → views throttled, one alert (Task 4 tests `a refresh is not a second view`, `interest is recorded once`).

---

### Task 1: Migration 112

**Files:** Create `packages/db/migrations/112-a-unit-kept-off-market.sql`; Test `apps/api/test/the-pocket-tables.test.mjs` (DB; pattern of `the-pf-tables.test.mjs`).

**Interfaces:** Produces `property_units.pocket boolean not null default false`, `property_units.pocket_since timestamptz`; table `unit_pocket_shares` per spec §8; unique partial index `unit_pocket_shares_one_active on (unit_id, deal_id) where revoked_at is null`; index on `token`.

- [ ] Step 1: failing test — source checks (one `begin; set local lock_timeout = '5s'; … commit;`, `if not exists` everywhere, every `add constraint` preceded by `drop constraint if exists`); DB: a token of 42 chars fails 23514; `view_count = -1` fails 23514; a second active share for the same unit and deal fails 23505, a second after `revoked_at` is set succeeds; another business cannot see the share (RLS); `nexus_app` cannot delete (42501).
- [ ] Step 2: run → FAIL (file missing).
- [ ] Step 3: write the migration (RLS policy `unit_pocket_shares_tenant_isolation` as 110's; grants select/insert/update; revoke delete).
- [ ] Step 4: apply to the test DB; run → PASS.
- [ ] Step 5: commit `feat(pocket): migration 112 — a unit kept off-market`.

### Task 2: Pure rules

**Files:** Create `packages/shared/src/portals/pocket.ts`; Modify `packages/shared/src/index.ts`, `packages/shared/src/workflows/board.ts`; Test `apps/api/test/the-pocket-rules.test.mjs`.

**Interfaces — Produces:**
- `type PocketShare = { id: string; dealId: string; contactName: string | null; sharedBy: string | null; createdAt: string; expiresAt: string; revokedAt: string | null; firstViewedAt: string | null; lastViewedAt: string | null; viewCount: number; interestedAt: string | null; active: boolean }`
- `BoardUnit.pocket: { on: boolean; since: string | null; shares: PocketShare[] }`
- `type PocketMatch = { deal: BoardDeal; fit: "fits" | "over" | "unknown"; overBy: number | null; shared: boolean }`
- `pocketMatches(unit: BoardUnit, deals: BoardDeal[]): PocketMatch[]`
- `pocketMessage(p: { firstName: string | null; title: string; community: string; priceAed: number; url: string; agentFirstName: string | null; businessName: string }): string`
- `whatsappLink(number: string | null, text: string): string | null` (digits 6–20 → `https://wa.me/<digits>?text=<encoded>`, else null)
- `POCKET_SHARE_DAYS = 14`; `POCKET_STEPS = ["D3","D4","D5","D6","D7"]`
- `stepNeeds(card, published)`: for a unit with `pocket.on`, the S10 need is `need("Shared privately with a buyer", published)` instead of the portal line.

- [ ] Step 1: failing tests — `buyers who fit come first, closest budget first`: price 1 000 000; budgets 950 000 (fits), 2 000 000 (fits, further), 800 000 (over 200 000), null (unknown), a rent deal (excluded), a deal on D8 (excluded) → order [950k, 2M, 800k, null], overBy 200000 for the third; `a buyer with an active share is marked shared` (expired share → not shared); message exact: `Hi Sara, a private listing I think fits what you're looking for: Palm villa with beach access, Palm Jumeirah, AED 12,500,000. It's off-market, so please keep it to yourself: https://app.nexusagenticos.com/pocket/T — Aisha, SFS International` (no first name → "Hi,"; no agent → "— SFS International"); `whatsappLink("971501112233", "a b")` = `https://wa.me/971501112233?text=a%20b`, `whatsappLink("AE.123", "x")` = null; S10 for a pocket unit lists "Shared privately with a buyer" and not "Live on at least one portal".
- [ ] Step 2: run → FAIL. Step 3: implement (price formatted `en-US` with commas). Step 4: run → PASS. Step 5: commit `feat(pocket): matching, the message and the S10 need`.

### Task 3: Records — the switch, sharing, the board

**Files:** Create `packages/db/src/pocket-listings.ts`; Modify `packages/db/src/index.ts`, `packages/db/src/workflow-board.ts` (UNIT_SELECT pocket + shares, `toUnit`, export `readDeal` and `SEES_DEAL`), `packages/db/src/portal-listings.ts` (export `listingContext`; `setUnitPortal` refuses `wanted: true` on a pocket unit; `publishedListings` adds `and not u.pocket`); Test `apps/api/test/the-pocket-records.test.mjs` (DB).

**Interfaces — Produces:**
- `setUnitPocket(org, unitId, on: boolean, actor: Actor, viewer: Viewer): Promise<BoardUnit | "closed" | null>`
- `createPocketShare(org, unitId, dealId, actor: Actor, viewer: Viewer, today: string): Promise<{ share: PocketShare; token: string; created: boolean; recipient: { firstName: string | null; number: string | null }; unit: { title: string; community: string; priceAed: number }; agentFirstName: string | null } | { refused: string } | null>`
- `revokePocketShare(org, unitId, shareId): Promise<boolean>`
- Refusal words: "Turn Pocket on first."; `portalProblemSentence` with "Before it can be shared" (add an optional lead parameter to `portalProblemSentence(problems, lead = "Before it can go on the portals")`); "That buyer is not on your board for this kind of unit."; "A pocket listing stays off the portals — turn Pocket off to publish it."

- [ ] Step 1: failing tests — `Pocket on turns every portal off and keeps it off` (and records the actor); `a pocket unit's switch cannot go on` (refusal sentence); `the feed leaves a pocket unit out even with a switch on` (set `wanted` by owner SQL, `publishedListings` excludes it); `Pocket off revokes every active share`; `a share needs Pocket on and a ready unit` (sentences); `staff cannot share with a colleague's client` (deal of another owner → refusal); `sharing again answers the same active link`; `an expired share is replaced by a new one`; `the board carries the pocket and its shares but never a token`; closed unit → "closed"; unknown → null.
- [ ] Step 2: run → FAIL. Step 3: implement (share creation in one `withTenant` transaction: lock the unit row, re-read readiness, revoke an expired active share for the pair, insert). Step 4: run with `the-portal-records`, `the-board-carries-the-listing`, `the-workflow-board-records`, typecheck → PASS. Step 5: commit `feat(pocket): records for the switch, sharing and the board`.

### Task 4: Records — the public view

**Files:** Modify `packages/db/src/pocket-listings.ts`; Test `apps/api/test/the-pocket-view.test.mjs` (DB).

**Interfaces — Produces:**
- `type PocketView = { businessName: string; recipientFirstName: string | null; title: string; description: string; purpose: "rent" | "sale"; priceAed: number; propertyType: string; bedrooms: number | null; bathrooms: number | null; sizeSqft: number; furnishing: string | null; community: string; subCommunity: string | null; amenities: string[]; availableFrom: string | null; photoIds: string[]; agent: { name: string; firstName: string; brn: string; whatsapp: string | null }; orn: string; permitNumber: string; expiresAt: string }`
- `pocketShareView(token: string): Promise<{ organizationId: string; shareId: string; view: PocketView } | null>` (one `withAllTenants` lookup; every spec §1 check; null when any fails)
- `notePocketView(org, shareId): Promise<void>` (count only when `last_viewed_at` is null or older than 10 minutes)
- `pocketPhoto(token: string, photoId: string): Promise<Uint8Array<ArrayBuffer> | null>`
- `recordPocketInterest(token: string): Promise<{ first: boolean; notify: string | null; title: string; recipientFirstName: string | null; agentFirstName: string | null } | null>` (`notify` = employee id: the unit's agent, else who shared)

- [ ] Step 1: failing tests — `a fresh share shows the listing`; `every rule is checked on every view` (revoked, expired, unit closed, Pocket off, permit expired, business inactive → null); `the page never carries what stays private` (no `building`, `reference`, `notes`, `owner` keys and the building text nowhere in the JSON); `a refresh is not a second view` (two notes → count 1; after moving `last_viewed_at` back 11 minutes → 2); `a photo is served only for its own unit while available`; `interest is recorded once` (first true then false; `notify` = agent id).
- [ ] Step 2–5: run FAIL → implement → PASS → commit `feat(pocket): the public view records`.

### Task 5: The API

**Files:** Modify `apps/api/src/routes/workflow-board.ts`; Create `apps/api/src/routes/pocket-public.ts`; Modify `apps/api/src/index.ts` (`app.route("/pocket-shares", pocketPublicRoute)`), `apps/api/src/services/push-dispatcher.ts` (`notifyPocketInterest(employeeId: string, text: string): Promise<void>`); Tests `apps/api/test/the-pocket-door.test.mjs` (mocked db), update mocks in `the-workflow-board-door`, `the-portal-door`, `the-pf-door`, guard tests (`a-bare-id-route-restricts-itself` PUBLIC_BY_DESIGN, `nothing-the-server-can-do-is-unreachable` REACHED_ELSEWHERE for `/pocket-shares/*` — the page reaches them server-side and from the browser).

**Interfaces — Produces:** `POST units/:id/pocket`, `POST units/:id/pocket/shares` (201 created / 200 existing; body `{ share, url, message, whatsappUrl }`), `DELETE units/:id/pocket/shares/:shareId`; public `GET /pocket-shares/:token`, `GET /pocket-shares/:token/photos/:file` (`<uuid>.jpg`), `POST /pocket-shares/:token/interest`.

- [ ] Step 1: failing tests — writes need a writer (look-only 403); share answer shape (url `https://app.nexusagenticos.com/pocket/<token>`, message via `pocketMessage`, `whatsappUrl` null for a username customer); refusals → 422 with the sentence; public GET: headers (`cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex, nofollow`), 404 `{ error: "unavailable" }`; `a malformed token is unavailable without a lookup` (the mocked lookup is not called); interest → `notifyPocketInterest(agentId, "Sara is interested in <title> (pocket listing)")` only when `first`; a push failure still answers 200.
- [ ] Step 2–5: FAIL → implement → PASS (plus the guard tests) → commit `feat(pocket): board and public routes`.

### Task 6: The Pocket section on the card

**Files:** Modify `apps/web/lib/api.ts` (`setUnitPocket`, `sharePocket`, `revokePocketShare`), Create `apps/web/app/deck/workflow/board/pocket-section.tsx` (`PocketSection`, `ShareWindow`, `shareState(share, now, timezone): string`), Modify `card-detail.tsx`, `board-panel.tsx`, `portals-section.tsx` (locked switches + sentence), `board-card.tsx` (badges), `workflow.css`; Tests `apps/web/test/the-pocket-section.test.mjs`, update `the-portal-sections` / `the-workflow-board` fixtures (`pocket: { on: false, since: null, shares: [] }`).

**Copy:** switch label "Pocket listing", note "Off-market: shared privately, never on the portals."; section heading "Pocket"; "Share privately" list rows "Sara Khan · Fits the budget" / "· Over budget by AED 200,000" / "· Budget not known" / "· Shared"; share states "Sent 7 Nov · not opened yet", "Opened 3× · last 10:42, 7 Nov", "Interested 10:45, 7 Nov", "Expired 21 Nov", "Revoked"; buttons "Share", "Revoke", "Send on WhatsApp", "Copy message", "Copy link"; badges "Pocket", "Interested in a pocket listing".

- [ ] Steps: failing tests for each word above (render with `renderToStaticMarkup`), the locked portal switches with the sentence, the S10 line for pocket units → implement → PASS + web suite → commit `feat(pocket): the Pocket section, the share window and the badges`.

### Task 7: The private page

**Files:** Create `apps/web/app/pocket/[token]/page.tsx` (server component; `metadata.robots` noindex/nofollow; fetch `${API_URL}/pocket-shares/<token>` with `cache: "no-store"`), `apps/web/app/pocket/[token]/interest-button.tsx` (client), `apps/web/app/pocket/pocket.css`; Modify `apps/web/next.config.mjs` (`/pocket/:path*` headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`); Test `apps/web/test/the-pocket-page.test.mjs`.

**Interfaces:** `PocketPage` view component exported for tests: `PocketListing({ view, token, apiUrl })`; `Unavailable()`.

- [ ] Steps: failing tests — the page shows "Private listing — shared with Sara", "Please keep it to yourself", price ("AED 12,500,000" sale; "AED 160,000 a year" rent), the agent with BRN, ORN, permit number, "Available until 21 Nov 2026", photos from `/pocket-shares/<token>/photos/<id>.jpg`; "WhatsApp Aisha" link with the prefilled text; no building or reference; Unavailable text exact; next.config has the three headers for `/pocket/:path*`; the interest button posts to `/pocket-shares/<token>/interest` and shows "Thank you — Aisha will be in touch." → implement → PASS → commit `feat(pocket): the private listing page`.

### Task 8: Whole-branch check and preview

- [ ] Full API suite with the DB (`--test-concurrency=1`), web suite, typecheck, `next build` (no dev preview running).
- [ ] Preview with the stand-in (`C:\CLAUDE CODE\bacora\.claude\nexus-mock\board-mock.mjs`: pocket switch, shares, public pocket routes): turn Pocket on for the Palm villa, share with Sara Khan, open the private page, press I'm interested, see the card update. Commit any copy fixes.
