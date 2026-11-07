# Property Finder connection: the key, the sync engine, the card's answer

7 Nov 2026. Owner: "the api integration" — phase 2 of portal listings
(docs/superpowers/specs/2026-11-07-portal-listings-design.md §7). Asked where SFS stands on
Property Finder access, the owner chose "Not yet — build the rest": build everything that does
not depend on Property Finder's private listing format now; the listing calls follow when SFS
has the documentation.

## 1. What is known, and what is not

Public (7 Nov 2026):

- Enterprise API 2.0 is free for agencies. A **Decision Maker** creates an API key and secret in
  PF Expert → Developer Resources → API Credentials; a sandbox is made under Developer
  Resources → Sandboxes. (support.propertyfinder.ae article 28266806720914)
- Authentication is OAuth 2.0 client credentials: the key is the client id, the secret the
  client secret. Listings need the `listings:full_access` scope to create, update, publish and
  unpublish. (api-docs.propertyfinder.net/enterprise-api — the page is password protected; this
  much shows in its public summary)
- A token is requested with `POST https://auth.propertyfinder.com/auth/oauth/v1/token`,
  `Authorization: Basic base64(key:secret)`, JSON body
  `{"scope":"openid","grant_type":"client_credentials"}` (a Make.com community thread quoting the
  integration documentation, Jan 2025). **Provisional**: the sandbox may use another address.

Not public: the listing endpoints, the listing body, the location and property-type ids, the
error format. They are behind the documentation password, which only someone inside PF Expert
can open.

## 2. Scope

Built now:

1. The admin enters the API key and secret in Portal settings, chooses Sandbox or Live, and
   Nexus checks them by requesting a token. Stored encrypted, never shown back.
2. The sync engine: what to do for each unit (create, update, publish, unpublish, nothing), a
   worker job that does it, and the answer written back on the unit.
3. The Property Finder client in one file, `apps/api/src/lib/property-finder.ts`: the token
   request is real; the four listing calls exist with their final signatures but are switched
   off by one constant, `PF_LISTING_CALLS_READY = false`, so nothing is sent to Property Finder's
   listing API until they are written against the documentation.
4. The card and Portal settings say exactly where things stand.

Waits for the documentation (phase 2b): the bodies of the four listing calls, the location
picker (Property Finder's location id becomes a readiness item then), the property-type
mapping, leads from Property Finder.

## 3. The key

- Migration **111** adds to `portal_settings`: `pf_key_sealed text`, `pf_secret_sealed text`
  (both `sealToken` — AES-256-GCM, key outside the database, as channel tokens),
  `pf_key_ending text` (the key's last 4 characters, for the screen), `pf_environment text`
  (`sandbox` | `live`), `pf_checked_at timestamptz`, `pf_check_error text`. And to
  `unit_portals`: `remote_fingerprint text` (what was last sent, §5).
- **Save and check** (admin only): the key, the secret (both 1–200 printable characters, trimmed)
  and the environment are checked against Property Finder by requesting a token. The
  credentials are saved whatever the answer, with the answer: `pf_checked_at` and
  `pf_check_error` (null when the token came back). A wrong secret can then be corrected
  without retyping the key.
- **Check again** re-requests a token with what is saved (no retyping).
- **Disconnect** clears the six columns. Units already live on Property Finder stay live there
  (Nexus can no longer reach them); the card says so (§6).
- The key and secret never leave the server again: not in any answer, not in a log line, not in
  an error message (Property Finder's error text is kept, the request is not).
- A token is kept in the worker's memory only, until 1 minute before it expires (or 25 minutes
  when no expiry is given), per business. A 401 from Property Finder drops it and records
  "Property Finder refused the key" on the settings.

## 4. The Property Finder client (`lib/property-finder.ts`)

```ts
type PfCredentials = { key: string; secret: string; environment: "sandbox" | "live" };
type PfAnswer =
  | { ok: true; ref?: string }
  | { ok: false; kind: "refused"; message: string }      // Property Finder said no (4xx)
  | { ok: false; kind: "unreachable"; message: string }  // network, timeout, 5xx
  | { ok: false; kind: "key-refused"; message: string }; // 401/403 on the token or a call
checkKey(creds): Promise<PfAnswer>
createListing(creds, listing: PortalListing): Promise<PfAnswer>   // ok → ref
updateListing(creds, ref, listing): Promise<PfAnswer>
publishListing(creds, ref): Promise<PfAnswer>
unpublishListing(creds, ref): Promise<PfAnswer>
```

- `PF_ENDPOINTS` (one object, provisional): token URL per environment.
- 15 s timeout per request (`AbortSignal.timeout`). Messages trimmed to 300 characters.
- While `PF_LISTING_CALLS_READY` is false the four listing functions are never called (the
  engine checks the flag first); if called they answer `unreachable` "not built yet".
- The fetch function is injectable so tests never reach the network.

## 5. The sync engine

**The rule** (pure, `packages/shared/src/portals/pf-sync.ts`):

```ts
type PfRemote = { ref: string | null; state: PfState | null; fingerprint: string | null };
type PfState = "live" | "unpublished" | "refused" | "failed";
pfNextStep(should: { live: boolean; fingerprint: string | null }, remote: PfRemote):
  "create" | "update" | "publish" | "unpublish" | "none"
```

- `should.live` = wanted on Property Finder AND ready (`portalProblems` empty) — the same rule
  as the feed, decided when the job runs.
- Should be live: no ref → `create`; ref and a different fingerprint → `update`; ref, same
  fingerprint, state not live → `publish`; else `none`. A `refused` unit with the same
  fingerprint → `none` (nothing changed, so it would be refused again); a `failed` one is retried.
- Should not be live: state `live` → `unpublish`; else `none`.
- After `create` or `update` succeeds the engine publishes in the same run.

**The fingerprint** is a SHA-256 of the listing as it would be sent (`toPortalListing` output with
its photo addresses, without `updatedAt`), so a save that changes nothing sends nothing.

**The job** (`apps/api/src/queue/pf-sync-queue.ts` + `pf-sync-processor.ts`, BullMQ queue
`pf-sync`, worker concurrency 1 so a unit is never worked on twice at once):

- `cycle`: repeats every 10 minutes (fixed job id), heartbeat `pf-sync` (added to
  `SCHEDULED_JOBS`, stale after 45 minutes). For each business with a checked key
  (`pf_check_error is null`): every unit wanted on Property Finder or live there, up to 50 per
  business per cycle, oldest `synced_at` first.
- `unit`: one unit, job id `pf-unit-<unitId>`, 30 s delay, so several quick edits make one run.
  Added by the API after a Property Finder switch changes, a listing save, a photo added,
  reordered or removed, and when the key is saved and checked (a cycle job then).
- Nothing runs while `PF_LISTING_CALLS_READY` is false, the business has no key, or its key was
  refused. Nothing is written in that case.
- Each step's answer is written on the unit's `unit_portals` row: `remote_ref` (from create),
  `remote_state` (`live` after publish, `unpublished` after unpublish, `refused`, `failed`),
  `remote_message` (Property Finder's words for refused/failed, else null), `remote_fingerprint`
  (on a successful create/update), `synced_at = now()`. `key-refused` writes nothing on the unit
  and records the refusal on the settings. One unit's failure never stops the others.
- Enqueueing from the API never fails the request: when Redis is down the 10-minute cycle picks
  the change up, and the failure is logged.

## 6. What people see

Card, Property Finder line (`portalState`), in order of what applies first:

| Situation | Words |
|---|---|
| Not wanted, never live | Off |
| Not wanted, live on PF | Coming off Property Finder |
| Wanted, not ready | Off the portals: <first problem> |
| No key saved | Waiting for the Property Finder connection |
| Key refused | Property Finder refused the key — an admin can check it in Portal settings |
| Key fine, listing calls not built | Key saved — waiting for Property Finder's listing format |
| state live, same as sent | Live on Property Finder — updated <time> |
| refused | Property Finder refused it: <message> |
| failed | Could not reach Property Finder — trying again |
| otherwise (queued) | Sending to Property Finder… |

The board carries `pfConnection: "none" | "key-refused" | "waiting-format" | "connected"` and,
per unit, Property Finder's `state`, `message` and `syncedAt`.

Portal settings, Property Finder section:

- None saved: the steps (Decision Maker → Developer Resources → API Credentials → New API Key;
  start with a Sandbox), fields **API key**, **API secret** (password field), **Sandbox / Live**,
  **Save and check**.
- Saved: "Connected (Sandbox) — key ending 1a2b, checked 10:42, 7 Nov" or "Property Finder
  refused the key: <message>"; **Check again**, **Replace key**, **Disconnect** (confirm:
  "Nexus stops updating Property Finder. Listings already there stay until removed in PF
  Expert."). While the listing calls are not built: "Listings start going to Property Finder
  once its listing format is added to Nexus."

## 7. API

All admin-only, under `/api/organizations/:slug/workflow-board/portal-settings`:

- `GET` (existing) adds `propertyFinder: { saved: boolean, environment, keyEnding, checkedAt,
  checkError, listingCallsReady }` — never the key or secret.
- `PUT /property-finder` `{ apiKey, apiSecret, environment }` → checks, saves, answers the
  settings. 400 "Enter the API key and secret." / "Choose Sandbox or Live.". A check that
  fails is still a 200 with `checkError` set.
- `POST /property-finder/check` → re-checks the saved key; 404 "No Property Finder key is saved."
- `DELETE /property-finder` → clears it.

## 8. Errors and limits

- Property Finder unreachable during Save and check: saved, `checkError` "Could not reach
  Property Finder: <message>", Check again later.
- At most one check per business every 10 seconds (409 "Checking already — try again in a few
  seconds.") so a double click does not send two token requests.
- Keys longer than 200 characters or with control characters: 400.

## 9. Testing

Pure rule tests for `pfNextStep` (every row of §5), fingerprint stability, card words for every
row of §6; client tests with an injected fetch (token request shape: Basic header, body, timeout,
401 → key-refused, 5xx → unreachable, the secret never in a message); DB tests for the new
columns, sealing (the database holds no plain key), recording answers, the cycle's unit list;
processor tests with a fake client (create → publish, update on changed fingerprint, unpublish,
refused kept until a change, failed retried, key-refused stops the business, one unit's failure
does not stop the next, nothing runs while the flag is off); route tests (admin only, the key
never in an answer, the 10-second limit); web tests for the settings section and card states.

## 10. Choices taken under the owner's "go with my recommendation"

Build the engine now with listing calls switched off (instead of guessing Property Finder's
format or waiting); key entered by the admin in Portal settings (not a server variable, so SFS
can rotate it without a deploy); Sandbox/Live chosen on screen; a fingerprint instead of
comparing timestamps; worker concurrency 1 instead of per-unit locks; disconnect leaves live
listings alone (Nexus cannot remove them without a key).

## 11. Not in this piece

The listing call bodies, location picker and property-type mapping (phase 2b, with the
documentation); Property Finder leads; boosting and verification; Bayut's real tag names.
