# Portal listings (phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff complete a unit's listing (details, photos) on the Workflow Board card and switch it on
for Bayut, dubizzle and Property Finder; Nexus serves Bayut/dubizzle a feed of every wanted-and-ready
unit and records Property Finder intent for phase 2.

**Architecture:**
- One rules module in `@nexus/shared` (`portals/listing.ts`) decides readiness for the card and the server,
  and builds a portal-neutral `PortalListing`; `portals/bayut-feed.ts` turns listings into XML.
- Migration 110 adds listing columns, `unit_photos`, `unit_portals`, `portal_settings`, `employees.brn`.
- `packages/db/src/portal-listings.ts` holds the new reads/writes; `workflow-board.ts` returns the new
  fields. Publication is computed at read time (wanted AND ready), never stored.
- Board routes gain photos, switches and settings; a new unauthenticated route serves the feed and
  public photos outside `/api`.

**Tech Stack:** Next.js 14, React, Hono, Postgres with RLS, node:test with tsx.

**Spec:** `docs/superpowers/specs/2026-11-07-portal-listings-design.md`

## Global Constraints

- Setup: `npm ci` once at the worktree root before Task 1.
- Tests: API, shared and DB `npm --prefix apps/api test -- --test-concurrency=1`; web
  `npm --prefix apps/web test`; types `npm run typecheck`; build `npx next build` in `apps/web`
  (no dev server running).
- Real-database cases run only when `AUDIT_TEST_OWNER_URL` / `AUDIT_TEST_APP_URL` are set: this work's
  own throwaway Postgres `nexus-portal-pg` on port **55440** (scratchpad `portal-pg.sh`: postgres:16-alpine,
  role nexus_app, schema.sql + every migration in order). Each DB file takes `pg_advisory_lock(20261102)`,
  applies its own migration as the owner, seeds its own UUIDs, reads as `nexus_app`.
- Migrations are safe to run twice; every right a grant leaves out is revoked by name (050, 107).
- Route tests mock `@nexus/db` **by enumeration**: every new db export used by a route must be added to
  that route's test mocks (and the existing board door test's list).
- CRLF files (`apps/api/src/index.ts`, `packages/db/src/index.ts`) are edited with the Edit tool only;
  never `sed -i` (Git Bash turns them LF). Check `git diff --stat` per commit.
- Components import no CSS; pages do. Board styles live in `workflow.css` with `wf-board-` names
  (check for clashes first).
- Portals: `PORTAL_TARGETS = ["bayut", "dubizzle", "property_finder"]` (distinct from the existing
  manual `PORTALS` list, which stays).
- Photos: JPEG only; ≤ 4 MB (4_194_304 bytes); at least 800 × 600; at most 30 per unit; browser shrink
  longest 2048 px at quality 0.85.
- Public photo address: `${apiBaseUrl()}/portal-photos/<id>.jpg`; feed `${apiBaseUrl()}/portal-feeds/<token>/bayut.xml`.
- Exact copy:
  - "Before it can go on the portals: {items}." — items in this order, joined with ", ":
    "an open card", "the card on Listing & ads or Portals + social", "a permit that has not expired"
    (also used when any permit field is missing), "rent or sale", "a price", "the property type",
    "bedrooms", "bathrooms", "the size", "a title of 10 to 120 characters",
    "a description of at least 50 characters", "the community", "3 photos" | "1 more photo" |
    "{n} more photos", "an agent on the card", "the agent's BRN", "the agency's ORN".
  - "Photos must be JPEG." · "That photo is over 4 MB." · "Too small for the portals: at least 800 × 600 pixels."
    · "A unit has at most 30 photos." · "The order must list each of this unit's photos once."
  - "Only an admin can change portal settings."
  - Card states: "Off" · "In the feed — Bayut last read it {HH:MM, D Mon}" · "In the feed — Bayut has not read it yet"
    · "Waiting for the Property Finder connection" · "Off the portals: {first item}".
  - Settings: "Portal settings" · "Agency ORN" · "Bayut and dubizzle feed" · "Copy" · "New address" ·
    "The old address stops working at once. Bayut must be given the new one." · "Last read {when}" ·
    "Not read yet" · "Property Finder" · "Not connected yet. It needs SFS's Enterprise API key (PF Expert → Developer Resources)."
  - Sections: "Listing" · "Photos" · "Add photos" · "Cover" · "Move earlier" · "Move later" · "Remove" · "Portals" · "BRN".

## Review Focus

1. A unit published, then its permit expires overnight → it leaves the feed the next read with no job
   (Task 5 test `the feed drops a unit whose permit expired`).
2. A token from one business must never reveal another business's units or photos; the photo route must
   not serve a photo of an unpublished or closed unit (Task 7 tests).
3. Concurrent photo order changes / removing a photo mid-reorder → order call refused with the exact words,
   never a half-applied order (Task 5 test `an order that does not name every photo is refused whole`).
4. XML injection through title/description/building (`<`, `&`, `]]>`) → escaped, feed still parses
   (Task 3 test).
5. Staff in "View as staff" or another business → photos, switches, settings refused 403/404 (Task 6).

---

### Task 1: Migration 110 and the test database

**Files:** Create `packages/db/migrations/110-a-unit-goes-on-the-portals.sql`; create scratchpad
`portal-pg.sh`; test `apps/api/test/the-portal-tables.test.mjs`.

**Interfaces:** Produces tables/columns of spec §10 with these names:
- `property_units`: `title text check (title is null or char_length(btrim(title)) between 1 and 120)`,
  `description text check (… <= 5000)`, `size_sqft numeric(10,2) check (> 0)`, `bathrooms smallint 0–20`,
  `furnishing text check in ('furnished','semi_furnished','unfurnished')`, `city text not null default 'Dubai'`,
  `sub_community text`, `building text`, `parking smallint 0–20`, `amenities text[] not null default '{}'`
  checked `<@` the 18 keys of spec §2.1, `available_from date`.
- `unit_photos(id, organization_id, unit_id → property_units on delete cascade, position int >= 0,
  bytes bytea not null, width int 800–20000, height int 600–20000, size int 1–4194304,
  uploaded_by_employee_id, uploaded_by_admin_id, created_at)`; unique (unit_id, position) deferrable
  initially deferred; select/insert/update/delete.
- `unit_portals(organization_id, unit_id, portal check in ('bayut','dubizzle','property_finder'), wanted
  boolean not null default false, changed_at, changed_by_employee_id, changed_by_admin_id, remote_ref,
  remote_state, remote_message, synced_at, primary key (unit_id, portal))`; select/insert/update; revoke delete.
- `portal_settings(organization_id pk, orn text check ~ '^\d{1,10}$', feed_token text unique,
  feed_created_at, feed_last_read_at, feed_last_read_by text check <= 200)`; select/insert/update; revoke delete.
- `employees.brn text check (brn is null or brn ~ '^\d{1,10}$')`.
- Tenant policy on the three new tables exactly as 107's.

- [ ] Write `portal-pg.sh` (docker run nexus-portal-pg 55440, role nexus_app, schema.sql + migrations 001…110).
- [ ] Test (source checks always; DB cases when env set): `migration 110 is safe to run twice` (apply twice,
  no error); `nexus_app cannot delete a unit_portals row` (permission denied); `amenities refuse an unknown
  key`; `a photo below 800 wide is refused by the table`; `a BRN with letters is refused`; `another
  business's photos are invisible to nexus_app in this business's context`.
- [ ] Run: fails (no migration). Write the migration. Run: passes. Commit.

### Task 2: The readiness rule and the portal-neutral listing (shared)

**Files:** Create `packages/shared/src/portals/listing.ts`; export from `packages/shared/src/index.ts`;
extend `BoardUnit` in `packages/shared/src/workflows/board.ts`; test `apps/api/test/the-portal-rules.test.mjs`.

**Interfaces (Produces):**
```ts
export const PORTAL_TARGETS = ["bayut", "dubizzle", "property_finder"] as const;
export type PortalTarget = (typeof PORTAL_TARGETS)[number];
export const AMENITIES: readonly string[]; // the 18 keys of spec §2.1, in that order
export const AMENITY_WORDS: Record<string, string>; // "central_ac" → "Central A/C"
export const FURNISHING = ["furnished", "semi_furnished", "unfurnished"] as const;
export type ListingContext = { today: string; orn: string | null; agentBrn: string | null; photoCount: number };
export function portalProblems(unit: BoardUnit, ctx: ListingContext): string[];
export function portalProblemSentence(problems: string[]): string | null; // "Before it can go on the portals: …."
export type PortalListing = { reference: string; updatedAt: string; purpose: Purpose; priceAed: number;
  propertyType: PropertyType; bedrooms: number | null; bathrooms: number | null; sizeSqft: number;
  furnishing: string | null; title: string; description: string; city: string; community: string;
  subCommunity: string | null; building: string | null; amenities: string[]; parking: number | null;
  availableFrom: string | null; permitNumber: string; permitExpiresOn: string; photoUrls: string[];
  agent: { name: string; email: string | null; phone: string | null; brn: string }; orn: string;
  portals: PortalTarget[] };
```
`BoardUnit` gains: `title, description, sizeSqft, bathrooms, furnishing, city, subCommunity, building,
parking, amenities, availableFrom` (nullable as in §2; `city: string`, `amenities: string[]`),
`photos: { id: string; width: number; height: number }[]`, `portals: Record<PortalTarget, { wanted: boolean }>`,
`updatedAt: string`. `Board` gains `portalFeed: { lastReadAt: string | null } | null`, `ornSet: boolean`,
`agentBrns: Record<string, boolean>` (employee id → has BRN). `stepNeeds` S10 line is done when
`liveOn.length > 0` OR some portal is wanted.

- [ ] Tests: each item of Global Constraints' list appears for its own gap and in that order for a blank
  unit; a ready unit has none; office needs no bedrooms or bathrooms; "1 more photo" at 2, "3 photos" at 0;
  an expired permit gives "a permit that has not expired"; `portalProblemSentence([])` is null.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 3: The Bayut / dubizzle feed XML (shared)

**Files:** Create `packages/shared/src/portals/bayut-feed.ts`; test `apps/api/test/the-bayut-feed.test.mjs`.

**Interfaces:** `export function bayutFeedXml(listings: PortalListing[], generatedAt: string): string`;
`export function xmlText(s: string): string` (escapes & < > " '); `export function cdata(s: string): string`
(splits `]]>`). Provisional tag map (one `const BAYUT_TAGS` object, header comment "provisional until
Bayut's XML document arrives — phase 2 aligns this object only"): root `<Listings generated="…">`, one
`<Listing>` per unit with `Property_Ref_No, Permit_Number, Property_purpose (Rent|Buy), Property_Type,
Property_Status (live), City, Locality, Sub_Locality, Tower_Name, Property_Title, Property_Description
(CDATA), Property_Size, Property_Size_Unit (SQFT), Bedrooms, Bathroom, Price, Rent_Frequency (Yearly, rent
only), Furnished (Yes|No|Partly), Features/Feature, Images/Image, Listing_Agent, Listing_Agent_Email,
Listing_Agent_Phone, Listing_Agent_BRN, Agency_ORN, Portals/Portal (Bayut|dubizzle), Last_Updated`.
Only `bayut`/`dubizzle` are emitted in Portals.

- [ ] Tests: an empty list gives a well-formed document with zero `<Listing>`; a title with `<b>&` is
  escaped; a description containing `]]>` survives (parse back and compare text); dubizzle-only listing
  lists only `dubizzle`; studio (0 bedrooms) prints `0`; rent prints `Rent_Frequency` Yearly, sale does not.
  Parse with a minimal well-formedness check (no external dependency: balanced tags via a tiny tokenizer
  in the test).
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 4: The board reads and writes the listing

**Files:** Modify `packages/db/src/workflow-board.ts` (UNIT_COLUMNS, UNIT_SELECT, row mapping, `getBoard`),
`apps/api/src/routes/workflow-board.ts` (UNIT_CHECKS); test extend `apps/api/test/the-workflow-board-records.test.mjs`
and `the-workflow-board-door.test.mjs`.

**Interfaces:** `UnitFields` gains `title, description, sizeSqft, bathrooms, furnishing, city, subCommunity,
building, parking, amenities, availableFrom` → columns `title, description, size_sqft, bathrooms,
furnishing, city, sub_community, building, parking, amenities, available_from`. Checks: title `text(120)`,
description `text(5000)` keeping line breaks, sizeSqft `money`-like positive number, bathrooms `whole(0,20)`,
furnishing `oneOf(FURNISHING)`, city `text(100)` (blank → "Dubai"), subCommunity/building `text(200)`,
parking `whole(0,20)`, amenities array subset of AMENITIES without repeats, availableFrom `day`.
`getBoard` returns the Task 2 fields: photos (ordered by position, no bytes), portals (all three keys,
default `{ wanted: false }`), `portalFeed`, `ornSet`, `agentBrns`.

- [ ] Tests: door — `Invalid amenities.` for an unknown key; blank city saves as Dubai. Records (DB) —
  `updateUnit` saves and `getBoard` returns every new field; photos come without bytes in position order;
  `portals` defaults to three `{ wanted: false }`.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 5: Photos, switches and settings in the database

**Files:** Create `packages/db/src/portal-listings.ts` (export from `packages/db/src/index.ts`); test
`apps/api/test/the-portal-records.test.mjs`.

**Interfaces (Produces):**
```ts
addUnitPhoto(organizationId, unitId, photo: { bytes: Uint8Array; width: number; height: number }, actor: Actor)
  : Promise<{ id: string } | { refused: string } | null>   // null: no such open unit; refused: 30 cap
unitPhotoBytes(organizationId, unitId, photoId): Promise<Uint8Array | null>
orderUnitPhotos(organizationId, unitId, ids: string[]): Promise<true | { refused: string } | null>
removeUnitPhoto(organizationId, unitId, photoId): Promise<boolean>        // closes the position gap
setUnitPortal(organizationId, unitId, portal: PortalTarget, wanted: boolean, actor: Actor, today: string)
  : Promise<BoardUnit | { refused: string } | null>   // on: refused with portalProblemSentence unless ready
portalSettings(organizationId): Promise<{ orn: string | null; feedToken: string | null; feedLastReadAt: string | null; feedLastReadBy: string | null }>
setPortalOrn(organizationId, orn: string | null): Promise<void>
newPortalFeed(organizationId): Promise<string>                           // 32 random bytes, base64url
feedByToken(token: string): Promise<{ organizationId: string; timezone: string } | null>  // withAllTenants, one lookup
publishedListings(organizationId, targets: PortalTarget[], today: string, photoUrl: (id: string) => string): Promise<PortalListing[]>
noteFeedRead(organizationId, userAgent: string): Promise<void>           // at most once a minute
publicPhoto(photoId: string): Promise<Uint8Array | null>                 // only if unit open AND wanted on ≥ 1 portal
setEmployeeBrn(organizationId, employeeId, brn: string | null): Promise<boolean>
```
`publishedListings` loads open units wanted on any of `targets`, builds each with `portalProblems` and
keeps only ready ones; `portals` in each listing = wanted targets ∩ `targets`.

- [ ] DB tests: `a 31st photo is refused`; `an order that does not name every photo is refused whole`
  (positions unchanged); `removing the middle photo closes the gap`; `switching on an unready unit is
  refused with the sentence`; `off is always allowed`; `the feed drops a unit whose permit expired`
  (today after expiry → excluded, still wanted); `a closed unit is not published`; `publicPhoto is null for
  a photo of an unwanted unit`; `feedByToken finds only its business; a new address kills the old`;
  `noteFeedRead writes once a minute`; every function runs in `withTenant(organizationId,` except
  `feedByToken` and `publicPhoto` (source check: `withAllTenants` for one lookup, then tenant).
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 6: Board routes for photos, switches, settings and BRN

**Files:** Modify `apps/api/src/routes/workflow-board.ts`, `apps/api/src/routes/employees.ts`; test
`apps/api/test/the-portal-door.test.mjs` (+ add new mocks to `the-workflow-board-door.test.mjs`).

**Interfaces:** Routes of spec §9 under `/:slug/workflow-board`: `POST units/:id/photos` (multipart field
`photo`; checks JPEG magic bytes FF D8 FF and `image/jpeg`; size; reads width/height from the JPEG SOF
marker server-side — `jpegSize(bytes): { width, height } | null` in `apps/api/src/lib/jpeg-size.ts`),
`GET units/:id/photos/:photoId` (image/jpeg, private, `Cache-Control: private, max-age=300`),
`POST units/:id/photos/order`, `DELETE units/:id/photos/:photoId`, `POST units/:id/portals/:portal`
`{ wanted }` (unknown portal 404 "Unknown portal."), `GET/PATCH portal-settings`, `POST portal-settings/feed`
(operators only; staff 403 "Only an admin can change portal settings."; GET answers `{ orn, feedUrl,
lastReadAt, lastReadBy }` with `feedUrl` built from `apiBaseUrl()` or null). Employees:
`PATCH /:slug/employees/:employeeId/brn` `{ brn }` operator-only, digits 1–10 or null.
Every write refused 403 for look-only (`LOOK_ONLY`).

- [ ] Tests: each refusal's exact words; PNG bytes refused "Photos must be JPEG."; 799×600 refused; 4 MB+1
  refused; look-only 403 on photo add/switch; staff GET portal-settings 403; operator PATCH orn `12AB` →
  "Invalid orn."; feedUrl shape `https://api.nexusagenticos.com/portal-feeds/<token>/bayut.xml`; jpegSize
  reads a baseline and a progressive JPEG header (fixtures built in the test).
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 7: The public feed and photo addresses

**Files:** Create `apps/api/src/routes/portal-public.ts`; mount in `apps/api/src/index.ts` beside `/links`
(outside `/api/*`, CORS not needed); test `apps/api/test/the-portal-feed-door.test.mjs`.

**Interfaces:** `export const portalPublicRoute` with `GET /portal-feeds/:token/bayut.xml` → `feedByToken`
(404 plain "Not found" when null) → `publishedListings(org, ["bayut","dubizzle"], todayIn(timezone),
id => `${apiBaseUrl()}/portal-photos/${id}.jpg`)` → `bayutFeedXml`; `noteFeedRead` with the user agent,
never awaited into the answer's failure path (a failed note still serves the feed); headers
`application/xml; charset=utf-8`, `Cache-Control: no-store`. `GET /portal-photos/:file` accepts only
`<uuid>.jpg` → `publicPhoto` → bytes with `image/jpeg`, `Cache-Control: public, max-age=86400`, else 404.
Token shape checked before any lookup (`^[A-Za-z0-9_-]{43}$`).

- [ ] Tests (mocked db): wrong-shape token never reaches the db; unknown token 404; feed served with the
  right headers and the listings the db returned; a failing `noteFeedRead` still serves the feed; photo
  file `../x.jpg` or `abc.png` 404 without a db call; index.ts mounts `/portal-feeds` and `/portal-photos`
  outside `/api` (source check).
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 8: The card window — Listing, Photos, Portals

**Files:** Create `apps/web/app/deck/workflow/board/listing-section.tsx`, `photos-section.tsx`,
`portals-section.tsx`; modify `card-detail.tsx` (units only, after the papers), `board-panel.tsx`
(API calls), `apps/web/lib/team-chat/shrink-image.ts` (export `shrinkTo(file, longest, quality)`),
`workflow.css`; test `apps/web/test/the-portal-sections.test.mjs`.

**Interfaces:** `ListingSection({ unit, canEdit, onSave(fields) })` (touched fields only; amenities as
checkboxes with `AMENITY_WORDS`); `PhotosSection({ unit, canEdit, onAdd(files), onMove(id, -1|1), onRemove(id),
photoSrc(id) })` (Cover badge on the first; remove asks confirm); `PortalsSection({ unit, board, canEdit,
onSwitch(portal, wanted) })` showing the states of Global Constraints (time as HH:MM, D Mon in the
business timezone) and, when not ready, `portalProblemSentence`. Upload shrinks to 2048/0.85 and refuses
locally under 800×600 with the same words.

- [ ] Tests (server render with fixtures): the three headings; Cover on first photo only; a ready unit
  wanted on Bayut with `lastReadAt` shows "In the feed — Bayut last read it"; a wanted unit with an expired
  permit shows "Off the portals: a permit that has not expired"; Property Finder wanted shows "Waiting for
  the Property Finder connection"; look-only shows no Add photos button.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 9: Portal settings window and BRN on Team

**Files:** Create `apps/web/app/deck/workflow/board/portal-settings.tsx`; modify the board header
(`board-view.tsx` or `board-panel.tsx`: "Portal settings" button for operators only), the Team staff
details (`apps/web/app/deck/team/team-workspace.tsx`: BRN field, admins only); test
`apps/web/test/the-portal-settings.test.mjs`.

**Interfaces:** `PortalSettings({ slug, onClose })` loads `GET portal-settings`; ORN input saves on blur;
feed address with Copy and New address (confirm with the exact words); "Last read {when}" / "Not read yet";
Property Finder line. Team: BRN input (digits only) saved through `PATCH …/brn`.

- [ ] Tests: staff never see the "Portal settings" button; the window shows "Not read yet" with no read;
  New address asks the confirm words; Team shows BRN for admins only.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 10: Whole-suite check

- [ ] Full API suite with the DB (`--test-concurrency=1`), web suite, `npm run typecheck`, `npx next build`.
- [ ] Update the preview mock (`C:\CLAUDE CODE\bacora\.claude\nexus-mock\board-mock.mjs`) with the new fields,
  photos, switches and settings so the screens can be checked in the browser pane; take screenshots of the
  card's three sections and the settings window.
- [ ] Commit; ledger line.
