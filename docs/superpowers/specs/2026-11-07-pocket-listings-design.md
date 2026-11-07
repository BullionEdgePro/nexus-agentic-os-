# Pocket listings: off-market units shared privately with the right buyers

7 Nov 2026. Owner: "add pocket listing in sfs realestate work flow now — be creative and
reliable." A pocket listing is a unit the owner does not want advertised publicly; the agency
shows it discreetly to chosen buyers or tenants. Choices below were taken under the owner's
standing "go with my recommendation" (§12).

## 1. What "reliable" means here

- **Never public.** A pocket unit is never on Bayut, dubizzle or Property Finder: turning Pocket on
  switches every portal off in the same transaction, the portal switches stay locked while it is a
  pocket, and the feed and the Property Finder sync exclude pocket units even if a switch were on.
- **Within Dubai's rules.** Every property advertisement in Dubai needs a Trakheesi permit, and the
  public sources do not settle whether a one-to-one WhatsApp share counts (Gulf Business 2016, The
  National, broker guides). So a pocket unit can be shared only when it would be ready for the
  portals — the same `portalProblems` rule: on Listing & ads or Portals + social (which the database
  allows only with Form A and a permit), a permit valid today, the details, 3 photos, an active agent
  with a BRN, the agency's ORN. The permit is shown on the private page.
- **Nothing private leaves Nexus.** The private page never shows the building, the unit reference,
  the owner, the notes or the internal history.
- **Every view re-checks.** A link works only while the share is not revoked or expired, the unit is
  open and still a pocket, the business is active, and the unit is still ready (permit not expired).

## 2. The Pocket switch (unit card)

- A unit card gets **Pocket listing** — "Off-market: shared privately, never on the portals."
- On: `property_units.pocket = true`, `pocket_since = now()`; every `unit_portals` row of the unit
  set `wanted = false` (actor recorded, as a switch change); the card shows a **Pocket** badge.
- Off: every active share of the unit is revoked (`revoked_at = now()`).
- While pocket: the three portal switches are disabled with "A pocket listing stays off the portals —
  turn Pocket off to publish it."; the API refuses `wanted: true` with that sentence (422).
- Only on an open unit; a closed unit answers 409 as other writes do. Look-only ("View as staff")
  answers 403 as other writes do.

## 3. Matching buyers (pure, shared)

`pocketMatches(unit, deals, shares)` → `{ deal, fit: "fits" | "over" | "unknown", overBy: number | null, shared: boolean }[]`:

- Deals on the board the viewer can see (the board already hides a colleague's clients from staff),
  with the unit's purpose (rent/sale), on D3–D7 (not yet on the rent/sale deal steps).
- `fits`: budget ≥ 90% of the price; `over`: budget below that, `overBy = price − budget`;
  `unknown`: no budget.
- Order: fits (closest budget to the price first), then over (smallest gap first), then unknown;
  `shared: true` when the deal already has an active share of this unit.

## 4. Sharing

- **Share** (one per unit and deal while active): token `randomBytes(32).toString("base64url")`,
  `expires_at = now() + 14 days`, the deal's contact as the recipient, who shared it. Sharing again
  while one is active answers the active one (no second link).
- Refused (422) with a sentence: not a pocket ("Turn Pocket on first."), not ready ("Before it can
  be shared: …." — `portalProblemSentence`), a deal the viewer cannot see or another purpose ("That
  buyer is not on your board for this kind of unit."). Missing deal/unit → 404.
- The answer gives the link, the message and the WhatsApp link:
  - URL: `${appBaseUrl()}/pocket/<token>`.
  - Message: `Hi <first name>, a private listing I think fits what you're looking for: <title>,
    <community>, AED <price>. It's off-market, so please keep it to yourself: <url> — <agent first
    name>, <business name>`.
  - `whatsappUrl`: `https://wa.me/<digits>?text=<message>` when the contact's number is digits;
    null otherwise (a username-only customer: "Copy message" only).
- **Revoke** a share: `revoked_at = now()`; the page answers "no longer available".
- Staff send from their own phone (the WhatsApp button opens their app); Nexus sends nothing.

## 5. The private page (`/pocket/<token>`, no sign-in)

- Shows: the business name, "Private listing — shared with <first name>", "Please keep it to
  yourself", title, photos (in order), price (per year for rent), purpose, property type, bedrooms,
  bathrooms, size, furnishing, community, sub-community, amenities, description, available from;
  the agent's name and BRN; the agency ORN; the Trakheesi permit number; "Available until <date>".
- Buttons: **I'm interested** → records interest, answers "Thank you — <agent first name> will be
  in touch."; **WhatsApp <agent first name>** → `wa.me/<agent number>?text=Hi, about the private
  listing "<title>"` when the agent has a WhatsApp number.
- Never shows: building, unit reference, owner, notes, history, other units.
- Answers `robots: noindex, nofollow`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- Unavailable (any check in §1 fails, or an unknown token): "This private listing is no longer
  available. Ask the agent who sent it." — the same words for every reason.
- Photos: `/pocket-shares/<token>/photos/<photoId>.jpg` (API), served only for that share's unit
  while the share is available, `Cache-Control: private, no-store`.
- Views: `first_viewed_at`, `last_viewed_at`, `view_count` — at most one count per share per
  10 minutes (a refresh is not a second view).

## 6. Interest

- `POST /pocket-shares/<token>/interest` (no sign-in): only while available; sets `interested_at`
  the first time (later presses answer the same thanks); the agent on the unit (else whoever shared
  it) gets a phone alert "<first name> is interested in <title> (pocket listing)" once, linking to
  `/deck/workflow#board`. No push configured → nothing sent, nothing fails.

## 7. On the board

- Unit: `pocket: { on: boolean; since: string | null; shares: PocketShare[] }` with
  `PocketShare = { id, dealId, contactName, sharedBy, createdAt, expiresAt, revokedAt, firstViewedAt,
  lastViewedAt, viewCount, interestedAt, active }` — never the token after creation.
- Unit card window, **Pocket** section (after Portals): the switch; while on and ready, "Share
  privately" with the matches (§3) and a Share button each; the shares with their state:
  "Sent 7 Nov · not opened yet", "Opened 3× · last 10:42, 7 Nov", "Interested 10:45, 7 Nov",
  "Expired 21 Nov", "Revoked"; Revoke on active ones. While not ready: the §4 sentence.
- After Share: a window with the message, **Send on WhatsApp** (when there is a number),
  **Copy message**, **Copy link**.
- Board card badges: unit "Pocket"; a deal with an interested share "Interested in a pocket listing".
- S10 checklist: for a pocket unit "Live on at least one portal" becomes "Shared privately with a
  buyer", done when it is ready and has at least one active share.

## 8. Data (migration 112)

- `property_units`: `pocket boolean not null default false`, `pocket_since timestamptz`.
- `unit_pocket_shares`: `id uuid pk`, `organization_id`, `unit_id` (cascade), `deal_id` (cascade),
  `token text unique not null` (43 base64url chars), `created_by_employee_id`, `created_by_admin_id`,
  `created_at`, `expires_at`, `revoked_at`, `first_viewed_at`, `last_viewed_at`,
  `view_count int not null default 0 check (>= 0)`, `interested_at`; one active share per
  (unit, deal): unique partial index `where revoked_at is null` — expiry is checked at read time and
  an expired share is revoked when a new one is made; RLS tenant isolation as 110; `nexus_app`
  select/insert/update, no delete.

## 9. API

Board (signed in, under `/api/organizations/:slug/workflow-board`):
- `POST /units/:id/pocket` `{ pocket: boolean }` → the card.
- `POST /units/:id/pocket/shares` `{ dealId }` → `{ share, url, message, whatsappUrl }` (201; 200 for
  the existing active one).
- `DELETE /units/:id/pocket/shares/:shareId` → `{ ok: true }`.

Public (no session, mounted like `/portal-feeds`):
- `GET /pocket-shares/:token` → the page's data or 404 `{ error: "unavailable" }`.
- `GET /pocket-shares/:token/photos/:photoId.jpg`.
- `POST /pocket-shares/:token/interest` → `{ ok: true, agentFirstName }` or 404.
- The token lookup crosses businesses once (`withAllTenants`), everything after runs as the business.

## 10. Errors

Unknown/expired/revoked token, closed unit, pocket off, permit expired, inactive business: the one
"no longer available" answer. A malformed token is answered the same, without a database read.
Interest on an unavailable share: 404. A push failure is logged, never shown.

## 11. Testing

Pure: `pocketMatches` ordering and fit; S10 need for pocket units; card words for share states.
DB: migration shape; switching Pocket on turns portals off and keeps them off; off revokes shares;
one active share per unit and deal; the public view re-checks every rule; view counting throttle;
interest once; the feed and the PF sync exclude a pocket unit. Routes: refusals and sentences, staff
can share only deals they can see, look-only 403, the token never in the board, the public page's
headers and the fields it never shows. Web: the Pocket section, the share window, the public page.

## 12. Choices taken under "go with my recommendation"

Pocket shares need the portals' readiness (permit included) — safest reading of Dubai's rules;
recipients are buyers/tenants already on the board (tracked, own-book privacy) — no free-typed
numbers; links expire after 14 days; staff send from their own WhatsApp (Nexus sends nothing, so no
24-hour-window or template problems); the page hides building and unit reference; a phone alert on
interest. Not in this piece: sharing with outside agents (co-broking), watermarked photos, PDF
brochures, Arabic page text.
