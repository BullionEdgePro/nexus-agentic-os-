# Portal listings: list a unit once in Nexus, publish it to Bayut, dubizzle and Property Finder

7 Nov 2026. Owner: "bayut, property finder and dubizzle — my staff can list in Nexus and
automatically list on these marketplaces, integrated in Nexus." Built on the live Workflow
Board (spec 2026-11-03-sfs-workflow-board-design.md, migration 107). Choices were taken under
the owner's standing "go with my recommendation" (listed in §13).

## 1. What the owner gets, and when

The portals do not publish their integration specs openly (research, 7 Nov 2026):

- **Bayut and dubizzle** (one company) read an **XML feed** from a public address on their own
  schedule; one feed serves both. The tag list is emailed to the agency on request
  (support@bayut.com). Bayut activates the feed when the agency sends the address.
- **Property Finder** takes listings through **Enterprise API 2.0**: OAuth client credentials
  (an API key and secret a "Decision Maker" creates in PF Expert → Developer Resources; a
  token lasts 30 minutes, no refresh), endpoints to create, update, publish and unpublish
  listings, a sandbox, documentation behind a password the agency is given. A listing needs
  Property Finder's own location id, a property type id, a `licenses` block with the RERA
  permit, and a `publication` choice.
- Dubai law: no property advert without a valid Trakheesi permit (with its Madmoun QR), and
  every listing names the agency (ORN) and the agent (BRN). Portals check permits with DLD.

So the work is two phases:

- **Phase 1 — this build.** Everything that does not depend on the private specs: the listing
  itself (details and photos) on the unit card, the "ready for the portals" check, a publish
  switch per portal with its state, the business's feed address, Bayut/dubizzle's feed with a
  provisional tag map, public photo addresses, agent BRN and agency ORN.
- **Phase 2 — when SFS has the specs.** Align the feed's tag map with Bayut's document and send
  the address for activation; build the Property Finder adapter against Enterprise API 2.0,
  test it in the sandbox, add the location picker. Nothing in phase 1 has to be redone.

The owner's part, in parallel: (1) ask support@bayut.com for the XML feed documentation;
(2) the PF Decision Maker creates a sandbox API key and asks PF integration support for
Enterprise API documentation access; (3) give SFS's ORN and each agent's BRN.

## 2. The listing on the unit card

A unit already has: reference, community, property type, bedrooms, purpose, price (yearly rent
or asking price), cheques, the papers, the permit (Form A date, number, expiry), owner, agent.
New, all optional on the card and required only to publish (§4):

| field | type | notes |
|---|---|---|
| title | text 10–120 | "Bright 1-bed with canal view" |
| description | text 50–5000 | plain text, line breaks kept |
| size_sqft | number > 0 | built-up area, sq ft |
| bathrooms | 0–20 | |
| furnishing | furnished / semi_furnished / unfurnished | |
| city | text, default Dubai | |
| sub_community | text | e.g. "Bay Square" |
| building | text | tower or building name |
| parking | 0–20 | spaces |
| amenities | subset of a fixed list (§2.1) | |
| available_from | date | |

The existing `community` stays the area ("Business Bay").

### 2.1 Amenities

A fixed list, stored as keys, shown in plain words: balcony, built_in_wardrobes,
central_ac, covered_parking, maids_room, private_pool, shared_pool, private_garden,
shared_gym, security, concierge, view_of_water, view_of_landmark, pets_allowed,
kitchen_appliances, study, childrens_play_area, barbecue_area. Each portal adapter maps
the keys to its own codes.

### 2.2 Photos

- Up to 30 per unit, in order; the first is the cover.
- The browser shrinks each photo before sending (as team chat does): longest side 2048 px,
  JPEG quality 0.85. The server refuses anything but JPEG, over 4 MB, or smaller than
  800 × 600 ("Too small for the portals: at least 800 × 600 pixels.").
- Stored in the database (bytea, like team_files), with width and height.
- Anyone who may edit the unit may add, reorder (move earlier/later) and remove photos.
  "View as staff" is look-only (403), as for every board write.
- Each photo has a public address `https://api.nexusagenticos.com/portal-photos/<id>.jpg`
  (apiBaseUrl()). It answers only while its unit is open and published on at least one
  portal; otherwise 404. Staff see photos through the signed-in board route.

## 3. Agency and agent licences

- `portal_settings` per business: the agency's **ORN** (digits, 1–10) and the feed token.
- `employees.brn`: each agent's **BRN** (digits, 1–10), set by an admin on the Team page.
- A listing goes out under the card's agent. No agent on the card, or an agent without a BRN,
  no publishing.

## 4. Ready for the portals — one rule, used by the card and the server

`portalProblems(unit, ctx) → string[]` in @nexus/shared, words shown to staff. Empty means ready.
It needs, in this order:

1. the card is open, on Listing & ads (S9) or Portals + social (S10);
2. a valid permit today (Form A date, Trakheesi number, expiry not passed — the board's gate);
3. purpose and price; property type; bedrooms (except office, shop, warehouse, land);
   bathrooms (homes only: apartment, villa, townhouse, penthouse); size;
4. title (10–120 characters); description (at least 50 characters);
5. community; at least 3 photos;
6. an agent with a BRN; the business's ORN.

Shown as "Before it can go on the portals: a description, 2 more photos, the agent's BRN."

## 5. Publishing switches

- `unit_portals` (unit_id, portal ∈ bayut | dubizzle | property_finder): `wanted`, who and when
  last changed it, and for phase 2 the portal's own reference, state and message.
- Turning a portal **on** is refused (422, the words of §4) unless the unit is ready.
  Turning it **off** is always allowed.
- **What is published is decided when it is read, never stored**: a unit is in a portal's
  output only while it is wanted there AND ready (§4). So a permit that expires overnight, a
  card that closes (let, sold, withdrawn), or photos removed below 3 take it off the portals
  by themselves, without a job — and back on when fixed, if still wanted.
- The card's Portals section shows each switch with its state:
  - off: "Off";
  - wanted and ready: Bayut / dubizzle "In the feed — Bayut last read it 10:42"
    (or "Bayut has not read the feed yet"); Property Finder "Waiting for the Property Finder
    connection" until phase 2;
  - wanted but not ready: "Off the portals: <the first problem>" in the warn colour.
- The existing manual "Live on" ticks stay as the staff's own record (Meta and TikTok need
  them); the S10 checklist line "Live on at least one portal" is also satisfied by a unit
  wanted and ready on a portal.

## 6. The Bayut / dubizzle feed

- `GET /portal-feeds/<token>/bayut.xml` — outside /api (no session), like /links. A wrong or
  old token is 404. `Content-Type: application/xml; charset=utf-8`, `Cache-Control: no-store`.
- The token: 32 random bytes, base64url, per business, in `portal_settings`. Operators see the
  full address in the board's Portal settings and can make a new one ("New address": the old
  stops working at once — Bayut must be given the new one). Stored plainly: it unlocks only
  what the portals publish anyway.
- Each read records `feed_last_read_at` and the reader's user agent (200 chars), at most
  once a minute, so the card can say when Bayut last read it.
- Contents: every unit of that business wanted on bayut or dubizzle and ready, newest change
  first. Never the owner, notes, deals or anything not published on a portal.
- The XML comes from a portal-neutral `PortalListing` (shared) through one mapping module.
  **The tag names are provisional** until Bayut's document arrives (phase 2 changes that
  module only). Text is escaped; the description goes in CDATA with `]]>` split.

## 7. Property Finder (phase 2, recorded here so phase 1 fits it)

- Credentials stored encrypted like channel tokens (076's ciphertext columns), operator-only.
- A worker job every 10 minutes (and on a switch change) compares wanted-and-ready against
  `unit_portals.remote_state` and creates, updates, publishes or unpublishes on Property
  Finder; the answer (live, refused + reason) is written back and shown on the card.
- A location picker on the card searches Property Finder's locations (stored id + name).
- Phase 1 stores the switch; the card says "Waiting for the Property Finder connection".

## 8. Screens

- **Card window (unit)**: three new sections after the papers — "Listing" (the §2 fields),
  "Photos" (grid, Add photos, move earlier / later, remove with confirm, cover badge on the
  first), "Portals" (three switches with state, and the §4 list when not ready). Saves send
  only touched fields, as now.
- **Portal settings** (operators only), a window from the board's header: ORN; the Bayut /
  dubizzle feed address with Copy and New address, and when it was last read; Property
  Finder "Not connected yet — phase 2" with the steps the owner takes.
- **Team page**: BRN on a staff member's details (admins edit).

## 9. API

Under `/api/organizations/:slug/workflow-board` (requireTenantScope, the business's context):

- `PATCH units/:id` takes the §2 fields (same parser style: unknown keys dropped, bad values
  "Invalid <field>.").
- `POST units/:id/photos` (multipart `photo`), `GET units/:id/photos/:photoId`,
  `POST units/:id/photos/order` `{ ids }` (must be exactly the unit's photos),
  `DELETE units/:id/photos/:photoId`.
- `POST units/:id/portals/:portal` `{ wanted: boolean }` → the unit, or 422 with §4's words.
- `GET portal-settings`, `PATCH portal-settings` `{ orn }`, `POST portal-settings/feed`
  (new address) — operators only (403 for staff).
- The board payload adds per unit: the §2 fields, `photos: [{ id, width, height }]`,
  `portals: { bayut, dubizzle, property_finder: { wanted } }`; and per board
  `portalFeed: { lastReadAt } | null`, `orn: boolean` (set or not), `agentBrns` for the
  check (only whether each agent has one).
- Team: the existing employee update takes `brn`.

Outside /api: `GET /portal-feeds/:token/bayut.xml`, `GET /portal-photos/:id.jpg`
(`Cache-Control: public, max-age=86400`).

## 10. Database — migration 110

`110-a-unit-goes-on-the-portals.sql`, applied by hand as the owner before deploy:

- `property_units` add the §2 columns with checks; amenities `text[] not null default '{}'`
  checked against the list.
- `unit_photos` (id, organization_id, unit_id, position, bytes, width, height, size,
  uploaded_by_employee_id / admin_id, created_at); tenant policy; select, insert, update,
  delete (a photo is working material, unlike a card).
- `unit_portals` (organization_id, unit_id, portal, wanted, changed_at, changed_by_employee_id
  / admin_id, remote_ref, remote_state, remote_message, synced_at; pk unit_id + portal);
  tenant policy; select, insert, update; delete revoked.
- `portal_settings` (organization_id pk, orn, feed_token unique, feed_created_at,
  feed_last_read_at, feed_last_read_by); tenant policy; select, insert, update.
- `employees` add `brn`.
- Every revoke by name (default privileges grant everything — 050, 107).

The feed and photo routes read across the token's business with `withAllTenants` for the one
lookup by token or photo id, then everything else in that business's context.

## 11. Tests

Shared: `portalProblems` (each rule, order, words), XML escaping and CDATA, `PortalListing`
from a unit. API: field parsing; photos (type, size, minimum size, 30 cap, order must match,
look-only 403, another business 404); switches (refusal words, off always allowed); feed
(wrong token 404, only wanted+ready units, permit expired drops out, closed drops out, new
address kills the old); public photo (404 when not published); settings operator-only. Web:
the three sections render, the settings window, BRN on Team.

## 12. Not in this piece

The Property Finder adapter and location picker (phase 2); Bayut's exact tags (phase 2);
leads from the portals into Nexus (Bayut Leads API, PF leads) — a later piece; off-plan
details, videos, floor plans, watermarks; Abu Dhabi's Madhmoun; AI-written descriptions.

## 13. Choices taken under "go with my recommendation"

1. Two phases, phase 1 now, because the portals' specs are private (§1).
2. Publication decided at read time, not stored, so compliance (permit, closing) needs no job.
3. Photos in the database, shrunk in the browser, as team chat does.
4. Feed token stored plainly and shown to operators, with rotation.
5. Minimums: 3 photos, 50-character description, 10–120 character title.
6. Manual "Live on" ticks kept alongside automatic publishing.
7. Next migration 110; then 111.
