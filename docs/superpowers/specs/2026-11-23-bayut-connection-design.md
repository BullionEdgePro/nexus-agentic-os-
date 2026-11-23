# Bayut connection: list a unit on Bayut and dubizzle through Bayut's Profolio API

23 Nov 2026. Owner: "Yes, design it", after Bayut refused the XML feed (17 Nov, ticket 4292835:
"Bayut no longer provides or entertains the XML feed integration for managing listings; instead,
we offer the Listing API") and gave SFS a Sandbox account and token (19–20 Nov). Choices were
taken under the owner's standing "go with my recommendation" and are listed in §16.

Source for every Bayut fact below: `docs/reference/bayut-profolio-api.md` (read from
developers.bayut.com on 23 Nov 2026, not yet tested against the API).

## 1. Why, and what success looks like

SFS staff already list a unit once in Nexus (listing details, photos, a switch per portal —
spec 2026-11-07-portal-listings-design.md) and expected the Bayut and dubizzle switches to put
it on those portals. They never could: the switches fed an XML address Bayut no longer reads.

Success: an agent ticks Bayut (and/or dubizzle) on a ready unit, and within minutes the unit is
on Bayut — first on SFS's Sandbox account, then on the real one by swapping the token. When the
permit expires, the card closes, or the agent unticks, it comes off by itself. The card always
says, in plain words, where the listing stands on each portal and, when Bayut refuses it, why.

Goals:
1. An admin pastes the Bayut token once in Portal settings; Nexus checks it and shows which
   Bayut account it belongs to (the Sandbox account's name ends "- Sandbox").
2. Wanted + ready units are created on Bayut, published to the ticked portals, kept up to date
   when the listing changes, and taken off when no longer wanted or no longer ready.
3. The card shows each portal's real state, read back from Bayut, including Bayut's permit
   check and its rejection reasons.

Non-goals (this piece): paid boosts (Hot, Signature, Featured, Premium); Bayut leads into Nexus;
off-plan listings; videos; Arabic text; Property Finder (unchanged); agency trade-licence or
broker-licence validation through the API.

**Nexus manages only the Bayut listings it created** (it knows them by the Bayut id it got
back). Listings SFS made directly in Profolio are never read, changed or removed by Nexus. A
unit already advertised through Profolio must have that listing removed in Profolio before it is
ticked in Nexus, or Bayut gets it twice (§17). Listings Nexus created should be edited in Nexus:
an update replaces the whole listing, so edits made in Profolio are overwritten at the next
change in Nexus (the card says so).

Anti-goals — it fails even if it "works" when:
- it spends SFS's Bayut credits without staff asking (a loop that republishes, a test that
  posts to the real account);
- a listing stays advertised after its permit expired or the card closed;
- the token appears anywhere but the server (screen, log, error text, chat, repository);
- staff are told a listing is live when Bayut has not made it live.

## 2. What Bayut's API offers (summary of the reference)

- One base address `https://api.bayut.com/v1`, header `Authorization: Bearer <token>`. No
  separate sandbox address is documented: the token decides which account is used (Bayut:
  "the key sent is for the Sandbox account").
- `POST /properties` creates a **draft** (one property id for both portals). Required:
  `reference`, `title.en` (≤100), `description.en` (≤8000), `user_id` (the Bayut user posting
  it), `purpose` (`sale`/`rent`), `category` (slug), `location_id` (a deep location), `price`,
  `area` (sq ft), `images` (1–100, `{path: URL, is_main}`), and `rental_details.rent_frequency`
  for rent. Optional fields must be left out, never sent empty.
- `POST /properties/{id}/products/attach` with `{portals: [...]}` publishes; with
  `{portal}` adds a portal later. Publishing is **asynchronous**: in Dubai, Abu Dhabi and Al Ain
  it waits until Bayut validates the permit.
- `PUT /properties/{id}` replaces the whole listing (every field sent). `DELETE
  /properties/{id}` with `{portals}` makes it inactive there (not a hard delete; publishing
  again revives the same id).
- `GET /properties/{id}` gives each portal's `state` (`active`, `draft`, `inactive` seen) and
  `permit {number, status, comment}`. `GET /properties/rejected` gives reasons
  (`validation_details.category`, `status_code`, `description_en`). No webhooks yet.
- Lookups: `GET /categories` (slugs), `GET /amenities?title=`, `GET /locations?title=&level_N=`,
  `GET /users?agency_id=` (Bayut users, with `brn_number`), `GET /agencies`.
- 60 requests a minute per token; 429 with `retry_after`. 409 when the same listing is created
  or published twice at once.
- Pricing lists `publish-property` for 30 days with an amount per portal (16 Bayut, 15 dubizzle
  in the docs example; unit not stated), and wallets hold per-portal balances: **publishing very
  likely spends credits.**

## 3. Approaches

A. **A Bayut connection beside Property Finder's** (chosen). The same shape as the Property
   Finder connection already live (spec 2026-11-07-property-finder-connection-design.md): a
   token in Portal settings, a pure "what next" rule in `@nexus/shared`, a client file, a
   BullMQ job every 10 minutes plus one per changed unit, Bayut's answer written on
   `unit_portals`. Property Finder's code is not touched. Cost: some code looks like Property
   Finder's twice.
B. **One generic connector for all portals now.** Fold Property Finder and Bayut into one
   abstraction. Rejected: Property Finder's listing calls are still unknown, and reshaping live
   code for a guess adds risk for no gain to SFS.
C. **A "Send to Bayut" button, no background job.** Simplest. Rejected: nothing would take a
   listing down when its permit expires or the card closes — the first anti-goal of the
   portal-listings work.

## 4. The token (Portal settings)

- Migration 113 adds to `portal_settings`: `bayut_token_sealed` (sealToken, AES-256-GCM like
  channel tokens and the Property Finder key), `bayut_token_ending` (last 4 characters),
  `bayut_agency_id integer`, `bayut_agency_name text`, `bayut_checked_at`, `bayut_check_error`.
- **Save and check** (admin only): the token (1–500 printable characters, trimmed) is checked
  with `GET /agencies`. Success stores the first agency without a `parent_id` (else the first
  listed) as `bayut_agency_id` / `bayut_agency_name`, then reads `GET /users?agency_id=` to link
  staff (§5). The token is saved whatever the answer, with `bayut_check_error` (null when
  Bayut answered).
- **Replace token**: if the new token belongs to a different agency id than the saved one, every
  unit's Bayut and dubizzle switch is **turned off** and their remote columns are cleared (ref,
  state, message, fingerprint, publish time) — the old ids mean nothing on the new account, and
  nothing ticked during a Sandbox trial may go live on the real account by itself. Staff tick
  the units they want on the new account. Before saving, the window warns: "This token is for
  another Bayut account. Every Bayut and dubizzle switch will be turned off; tick the units
  again to publish them there." Same agency: nothing changes. This is how SFS moves from
  Sandbox to the real account.
- **Check again**, **Disconnect** (clears the token columns and the Bayut agent links; listings
  already on Bayut stay until removed in Profolio; the card says "Bayut connection removed —
  listings already on Bayut stay until removed in Profolio").
- The token never leaves the server: not in any answer, log line or error text. At most one
  check per business every 10 seconds (409 "Checking already — try again in a few seconds.").

## 5. Agents: each Nexus agent is linked to a Bayut user

A Bayut listing is posted by a Bayut user (`user_id`); the BRN lives on that user in Bayut.

- New table `bayut_agents (organization_id, employee_id, bayut_user_id integer, bayut_user_name
  text, linked_at)`, primary key (organization_id, employee_id), tenant policy, select/insert/
  update/delete.
- After a successful check, staff are linked automatically where a Nexus staff email equals a
  Bayut user's `contact.email` (case-insensitive). Existing links are kept.
- Portal settings lists Nexus staff with a **Bayut user** choice each (the Bayut users read at
  the last check, plus "Not linked"). Admins change it there.
- The Sandbox account has one Bayut user (the owner's), so for the Sandbox test the admin links
  the test agent to it by hand.

## 6. The Bayut location on the card

`location_id` must be a deep location (Bayut refuses area- or emirate-level ones).

- Migration 113 adds to `property_units`: `bayut_location_id integer`, `bayut_location_name
  text` (the breadcrumb joined with " › ", ≤300).
- The unit's Listing section gets **Bayut location**: a search box (3+ characters) shown only
  when the business has a checked token. It calls the Nexus API, which calls
  `GET /locations?title=<text>&level_2=<the unit's city>&per_page=10` with the business's token
  and answers `{id, name}` for results whose breadcrumb has **at least 4 levels** (UAE › Dubai
  › area › community or deeper). The search box starts with the unit's building, else
  sub-community, else community. Staff pick one; it is saved like any other field.
- Results are cached in Redis for a day per business and search text. Searches count against
  the same per-business call budget as the job (§10).

## 7. From a Nexus unit to a Bayut listing

`toBayutListing(listing: PortalListing, ctx)` in `@nexus/shared/portals/bayut-listing.ts`, pure:

| Bayut field | From Nexus |
|---|---|
| reference | the unit id |
| user_id | `bayut_agents.bayut_user_id` of the card's agent |
| title.en / description.en | title / description |
| purpose | purpose |
| category | apartment→`apartments`, villa→`villas`, townhouse→`townhouses`, penthouse→`penthouse`, office→`offices`, shop→`shops`, warehouse→`warehouses`, land→`residential-plots`; `other` is not sent (§8) |
| location_id | `bayut_location_id` |
| price | priceAed |
| rental_details | rent only: `{rent_frequency: "yearly"}` (Nexus prices rent per year) |
| area | sizeSqft |
| bedrooms | 0 → `-1` (studio); else the number; left out when null |
| bathrooms | left out when null |
| furnishing_status | furnished → `furnished`, unfurnished → `unfurnished`; semi-furnished left out |
| construction_status | `completed` |
| permit_number | the permit number |
| amenities | each Nexus amenity whose Bayut id is known (below), value `"true"` |
| images | the unit's public photo addresses in order, the first `is_main: true` |

Everything not in the table is left out. **Amenity ids**: after each successful check the job
reads `GET /amenities` once and keeps a map from Nexus keys to Bayut ids by matching titles
(case-insensitive, ignoring punctuation) against a fixed list of Bayut titles per key in the
same module; keys with no match are not sent. The map is stored in Redis per business.

The fingerprint (§9) is the SHA-256 of the canonical `toBayutListing` output.

## 8. Ready for Bayut

`portalProblems` (the generic rule, unchanged) plus, for Bayut and dubizzle only,
`bayutProblems(unit, ctx)`:

1. a title of at most 100 characters (Bayut's limit; Nexus allows 120);
2. a property type Bayut takes (not "Other");
3. the Bayut location;
4. the card's agent linked to a Bayut user (only when a token is saved — without a token the
   card says "Waiting for the Bayut connection" instead).

Turning Bayut or dubizzle **on** is refused (422) with both rules' words, as today. The XML feed
uses the same rule, so it stays correct while it exists (§13).

## 9. The sync rule

Pure, `packages/shared/src/portals/bayut-sync.ts`:

```ts
type BayutPortal = "bayut" | "dubizzle";
type BayutState = "draft" | "pending" | "live" | "unpublished" | "refused" | "failed";
type BayutRemote = {
  ref: string | null;                       // Bayut property id, same on both rows
  fingerprint: string | null;               // what was last sent successfully (or refused)
  portals: Record<BayutPortal, { state: BayutState | null; publishedAt: string | null }>;
};
type BayutStep =
  | { kind: "create" } | { kind: "update" }
  | { kind: "publish"; portals: BayutPortal[] }
  | { kind: "remove"; portals: BayutPortal[] };
bayutNextSteps(should: { portals: BayutPortal[]; fingerprint: string | null }, remote, now): BayutStep[]
```

`should.portals` = the portals wanted AND ready (both rules), decided when the job runs.

1. A portal with a ref whose state is anything but `unpublished` (or null) and is not in
   `should.portals` → `remove` — including `draft` and `pending`, so a listing waiting on
   Bayut's permit check can never go live after staff turned it off or it stopped being ready.
2. Nothing should be live → only step 1.
3. Same fingerprint as a refusal (`refused` on a wanted portal) → no create/update/publish
   until the listing changes.
4. No ref → `create`, then `publish` all of `should.portals`.
5. Ref and a different fingerprint → `update`, then `publish` any wanted portal whose state is
   `null`, `draft` (never published), `unpublished` or `failed`.
6. Ref, same fingerprint → `publish` the wanted portals whose state is `null`, `draft` (never
   published), `unpublished` or `failed`.
7. **A publish is asked once and then waited for.** `pending` (a publish was asked and Bayut
   has not made it live) is never published again, however long it waits — Bayut may be
   checking the permit. It ends when Bayut shows `active` (→ `live`), `inactive`
   (→ `unpublished`), or lists it as rejected (→ `refused`).
8. **Credit guard:** a portal is never published twice within 24 hours (its `publishedAt`), a
   last safety net against any loop.
9. **Nexus never republishes on its own.** When Bayut shows a portal `inactive` that Nexus held
   `live` or `pending` and still wanted (Bayut took it down, it expired, or someone removed it
   in Profolio), the job turns that portal's switch **off** (`wanted = false`, changed by the
   system) with the message "Bayut took it off on <date>". Ticking it again publishes it again
   — staff decide each time credits are spent.

Steps run in order; a failing step stops that unit's later steps for this run.

## 10. The job

`apps/api/src/queue/bayut-sync-queue.ts` + `bayut-sync-processor.ts`, BullMQ queue
`bayut-sync`, worker concurrency 1; the service `apps/api/src/services/bayut-sync.ts`; the
client `apps/api/src/lib/bayut.ts` (injectable fetch, 15 s timeout, messages trimmed to 300
characters, answers `{ok:true,data} | {ok:false, kind: "refused"|"unreachable"|"token-refused"|"busy"|"rate-limited", message, retryAfter?}`).

- `cycle` every 10 minutes (fixed job id; heartbeat `bayut-sync` in `SCHEDULED_JOBS`, stale
  after 45 minutes). For each business with a checked token, in this order (compliance first,
  so a spent call budget can never hold back a take-down):
  1. **removals**: run the rule for every unit with a ref whose result is a `remove` (unticked,
     permit expired, card closed, agent left);
  2. **creates, updates, publishes**: the rule for every other unit wanted on Bayut/dubizzle,
     oldest `synced_at` first;
  3. **states**: page through `GET /properties?agency_id=<id>&per_page=100` (one call per 100
     listings) and, for units Nexus holds a ref for: `active`→`live`, `inactive`→`unpublished`
     (with §9 rule 9), `draft` stays `pending` if a publish was asked, else `draft`; for
     `pending` units only, `GET /properties/{id}` once a cycle for the permit status and
     comment shown on the card;
  4. **rejections**: `GET /properties/rejected?rejection_type=all` (page 1, limit 50) — matching
     units become `refused` with `description_en`.
- `unit` job (`bayut-unit-<unitId>`, 30 s delay) after a switch, listing save, photo change,
  location change, or agent link change; a token save queues a cycle.
- **Call budget:** at most 40 Bayut calls per business per minute (job and location searches
  together), counted in Redis; when spent, the cycle stops and the next one continues. A 429
  stops that business until `retry_after` has passed. A 409 is `busy`: left for the next run.
- Answers written on each portal's `unit_portals` row: `remote_ref`, `remote_state`,
  `remote_message` (Bayut's words, or null), `remote_fingerprint` (after create/update
  success, or on refusal), `published_at` (new, the last publish asked), `synced_at`. 401/403 →
  `token-refused`: nothing written on units, `bayut_check_error` set, that business stops. One
  unit's failure never stops the next. Enqueueing never fails an API request.
- Photo addresses must answer while Bayut fetches them: they do, because a unit being sent is
  wanted and ready (the existing photo route rule).

## 11. What people see

Card, Bayut and dubizzle lines (`portalState`), first match wins:

| Situation | Words |
|---|---|
| Off because Bayut took it off (§9 rule 9) | Off — Bayut took it off on <date>. Tick to publish again (uses credits). |
| Not wanted, not live | Off |
| Not wanted, live, pending or draft on Bayut | Coming off Bayut |
| Wanted, not ready | Off the portals: <first problem> |
| No token | Waiting for the Bayut connection |
| Token refused | Bayut refused the token — an admin can check it in Portal settings |
| refused | Bayut refused it: <reason> |
| pending, permit status known | Waiting for Bayut's permit check — <comment or status> |
| pending | Sent to Bayut <date> — waiting for Bayut to publish it |
| live | Live on Bayut — checked <time>. Edit it here, not in Profolio. |
| failed | Could not reach Bayut — trying again |
| waiting for the 24-hour guard | Published less than a day ago — Nexus tries again <time> |
| otherwise | Sending to Bayut… |

(dubizzle lines say dubizzle.) The switch's on-confirm adds: "Publishing on Bayut uses Bayut
credits from SFS's account. If this unit is already on Bayut through Profolio, remove it there
first."

Portal settings, the **Bayut and dubizzle** section replaces the feed section:
- No token: steps (sign in to Profolio → the API token Bayut emailed, or from the dashboard),
  **API token** (password field), **Save and check**.
- Saved: "Connected to <agency name> — token ending 1a2b, checked 10:42, 23 Nov" or "Bayut
  refused the token: <message>"; **Check again**, **Replace token**, **Disconnect** (confirm).
- **Agents**: each staff member with their Bayut user choice (§5).
- A note: "Publishing uses Bayut credits. Boosts (Hot, Signature) are bought in Profolio."

## 12. API

Admin-only, under `/api/organizations/:slug/workflow-board/portal-settings`:
- `GET` adds `bayut: { saved, agencyName, tokenEnding, checkedAt, checkError, users: [{id,name,email}], links: [{employeeId, bayutUserId}] }` — never the token.
- `PUT /bayut` `{ token }` → check, save, answer the settings (400 "Enter the Bayut API token.").
- `POST /bayut/check`, `DELETE /bayut`, `PUT /bayut/agents/:employeeId` `{ bayutUserId | null }`.

Staff (board writers), under `/api/organizations/:slug/workflow-board`:
- `GET bayut/locations?q=` → `[{id, name}]` (400 under 3 characters; 409 "Connect Bayut first.").
- `PATCH units/:id` accepts `bayutLocationId` + `bayutLocationName` (both or neither).

The board payload adds `bayutConnection: "none" | "token-refused" | "check-failed" |
"connected"`, per unit `bayutLocation`, and per Bayut/dubizzle portal `state`, `message`,
`permitComment`, `syncedAt`, `publishedAt`; and whether each agent is linked.

## 13. Database — migration 113

`113-a-unit-goes-on-bayut.sql`, applied by hand as the owner before deploy (as 110–112):
`portal_settings` bayut columns (§4); `property_units.bayut_location_id/_name` (§6);
`bayut_agents` (§5); `unit_portals.published_at timestamptz`, `unit_portals.permit_comment text
(≤300)`; the `unit_portals_remote_state` check widened to add `draft` and `pending`. Every
revoke by name, tenant policies as 110–112.

The XML feed (`/portal-feeds/<token>/bayut.xml`) stays as it is in the code — nothing reads it —
but its section leaves Portal settings and the card stops saying "In the feed".

## 14. Errors and limits

- Bayut unreachable on Save and check: saved, "Could not reach Bayut: <message>".
- Images: Bayut fetches the photo addresses; if it refuses them the reason comes back through
  the rejected list or the 422 and shows on the card.
- Categories: the slug list is fixed in the module; a 422 naming `category` shows on the card.

## 15. Testing

Pure: `toBayutListing` (every row of §7, optional fields left out not null, studio −1, rent
frequency), `bayutProblems`, `bayutNextSteps` (every rule of §9 including the 24-hour guard and
a refusal kept until a change), card words for every row of §11. Client with injected fetch:
headers, 401/403 → token-refused, 422 → refused with Bayut's message, 429 → rate-limited with
`retry_after`, 409 → busy, 5xx/timeout → unreachable, the token never in a message. DB: sealing
(no plain token stored), agent links, the clear on agency change. Processor with a fake client:
create → publish, update on change, remove on untick / expired permit / closed card, rejected
list, state refresh, budget stop, token-refused stops one business only. Routes: admin-only,
the token never in an answer, the 10-second check limit, location search. Web: the settings
section, the location picker, card lines.

**Never** in automated tests: a real Bayut call. The first real calls are the owner's Sandbox
trial after deploy (§17).

## 16. Choices taken under "go with my recommendation"

1. Approach A, beside Property Finder, not a generic connector (§3).
2. The token typed by an admin in Portal settings, not a server variable (rotate without a deploy).
3. No Sandbox/Live switch: one address, the account named after the check; a token for another
   agency clears the Bayut ids so units are created afresh.
4. Agents linked by email automatically, changeable by an admin.
5. A Bayut location picker on the card, deep locations only (≥4 levels).
6. land → `residential-plots`; semi-furnished left out; rent sent as yearly; studio as −1.
7. Amenities matched by title once per check; unmatched ones left out.
8. Nexus never republishes on its own: a listing Bayut takes off turns its switch off and
   staff tick it again; a publish waiting on Bayut's permit check is waited for, never repeated;
   a 24-hour guard as a last safety net (credits).
9. Nexus manages only listings it created; Profolio listings are left alone, and a unit already
   on Bayut through Profolio is removed there before it is ticked in Nexus.
10. Moving to another Bayut account turns every Bayut and dubizzle switch off, so nothing from a
    Sandbox trial goes live on the real account by itself.
11. Removals run first in each cycle and states are read in pages of 100, so the call budget
    never holds back a take-down, whatever the number of listings.
12. The generic readiness rule stays as it is (ORN and BRN still required by Nexus, though Bayut
    holds its own copies).
13. The XML feed left in code, hidden from screens.
14. Next migration 113.

## 17. Rollout

1. Build, test, owner says "Deploy it"; migration 113 applied.
2. Admin pastes the **Sandbox** token; check shows "Sfs International Real Estate - Sandbox".
3. One test unit with a real permit, linked agent and Bayut location → Bayut ticked; confirm in
   the Sandbox Profolio (credits there are test credits).
4. Owner asks Bayut for the Production token; admin uses **Replace token**; every Bayut and
   dubizzle switch turns off.
5. For each unit SFS already advertises through Profolio: remove that listing in Profolio, then
   tick the unit in Nexus. Units not yet on Bayut are simply ticked.

## 18. Open questions for Bayut (do not block the build)

Whether publishing debits credits and in what unit; what a too-low balance returns; the full
list of portal states and permit statuses; image size/format rules; whether `portals` on Create
is ignored. The design works either way; answers refine the card's words.

## 19. Not in this piece

Boosts; Bayut leads (pull or webhook) into Nexus; off-plan; videos and Arabic; broker-licence
validation; removing the XML feed code; Property Finder's listing calls.
