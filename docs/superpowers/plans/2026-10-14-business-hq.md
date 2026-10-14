# Business HQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only "Business HQ" in Nexus: one dashboard per business with automatic daily website/SEO checks, staleness-tracked notes, a health score, and a locked credential vault.

**Architecture:** New tables (migration 097) behind RLS, read cross-tenant by operator-only Hono routes under `/api/hq`. Pure logic (health score, staleness, provider detection, hostname safety, card refusal, SEO parsing) lives in small tested modules; a worker job runs the network checks daily. Vault secrets are sealed with a dedicated `NEXUS_VAULT_KEY`; reveals need a 5-minute server-side unlock window opened by the admin's own password.

**Tech Stack:** Hono API + BullMQ worker, Postgres (RLS), Redis, Next.js 14 web (deck), node:crypto AES-256-GCM, node:dns/node:tls, RDAP, Google PageSpeed Insights v5. Tests: node:test text pins + real pure-function tests (`apps/api/test/*.test.mjs`), web render tests (`apps/web/test`).

**Spec:** `docs/superpowers/specs/2026-10-14-business-hq-design.md`

## Global Constraints

- Every `/api/hq` route behind `operatorOnly`; staff never get the nav item, page, or API.
- Unlock window 5 minutes (`hq:unlock:<adminId>`, `EX 300`); 5 wrong passwords → unlocking locked 15 minutes (`hq:unlock-fail:<adminId>`); revealed text hides after 30 s.
- Passwords flagged after 180 days; keywords stale after 30 days; GBP post 7 days, GBP photo 30 days; social last post 14 days.
- Health: start 100; critical −25, warning −10, notice −3; floor 0. A check that could not run is "unknown", a notice, never passing.
- `NEXUS_VAULT_KEY` ≥ 32 chars, **no fallback**; without it the vault refuses to save or reveal.
- No list response ever contains a password; every reveal writes `hq_vault_reveals` (entry, admin, time, IP, user agent).
- Card-like numbers (Luhn-valid 13–19 digits) refused in every vault field.
- Outbound fetches only to the business's validated hostname (no IPs, no ports, no internal names) and the fixed APIs (rdap.org, PageSpeed).
- Daily check 06:00 Asia/Dubai; "Check now" at most once per 5 minutes per business.
- review-demo is excluded from Business HQ.
- Migrations applied as owner via psql BEFORE the code that reads them deploys.

## Review Focus

1. A `.ae` domain RDAP cannot answer (no RDAP service) → the expiry shows "unknown — could not check", never a crash or a false green. (Task 4 test.)
2. A site behind Cloudflare → hosting reads "Behind Cloudflare (real host hidden)", not "hosted by Cloudflare". (Task 3 test.)
3. A website stored as `https://www.example.com/` → the checked hostname is `www.example.com`, the registrable domain for RDAP is `example.com`. (Task 3 test.)
4. The unlock window expires between opening the vault and pressing Reveal → 401 "Unlock again", and nothing is revealed or logged as revealed. (Task 6 test.)
5. PageSpeed times out or rate-limits → speed is "unknown", other checks still complete. (Task 4 test.)

---

### Task 1: Tables and the HQ data module

**Files:**
- Create: `packages/db/migrations/097-a-business-knows-what-it-owns.sql`
- Create: `packages/db/src/hq.ts`; export from `packages/db/src/index.ts`
- Test: `apps/api/test/a-business-knows-what-it-owns.test.mjs`

**Interfaces:**
- Produces (all cross-tenant via `withAllTenants("business hq: …", …)`):
  - `getHqProfile(orgId): Promise<HqProfile | null>`; `upsertHqProfile(orgId, patch: Partial<HqProfileFields>, adminId: string): Promise<HqProfile>`
  - `listHqKeywords(orgId)`, `upsertHqKeyword(orgId, {id?, keyword, position: number|null, checkedAt: string|null})`, `deleteHqKeyword(orgId, id)`
  - `listHqSocialAccounts(orgId)`, `upsertHqSocialAccount(orgId, input, adminId)`, `deleteHqSocialAccount(orgId, id)`
  - `listVaultEntries(orgId): Promise<VaultEntryPublic[]>` (no secret field at all), `getVaultSecretSealed(orgId, id): Promise<string|null>`, `upsertVaultEntry(orgId, input & {secretSealed?: string}, adminId)`, `softDeleteVaultEntry(orgId, id, adminId)`
  - `recordVaultReveal({entryId, orgId, adminId, ip, userAgent})`, `listVaultReveals(orgId, limit=50)`
  - `recordHqCheck({orgId, kind, ok: boolean|null, data, error})`, `latestHqChecks(orgId): Promise<Record<HqCheckKind, HqCheckRow>>`
  - `type HqCheckKind = "rdap" | "dns" | "tls" | "http" | "speed" | "seo" | "platform"`

- [ ] **Step 1: Write the failing test** — pins: the six tables exist with `enable row level security` and the tenant policy; `hq_vault_entries` has `secret_enc text` and `secret_changed_at`, `deleted_at`; `hq_vault_reveals` has `ip text` and `user_agent text`; `listVaultEntries` select list does NOT contain `secret_enc`; every exported function body contains `withAllTenants("business hq:`.
- [ ] **Step 2:** Run `bash $SP/apitest.sh test/a-business-knows-what-it-owns.test.mjs`. Expected: FAIL (ENOENT).
- [ ] **Step 3:** Write migration 097 (tables per spec §6, `grant select, insert, update, delete … to nexus_app`, `hq_checks` index on `(organization_id, kind, ran_at desc)`) and `packages/db/src/hq.ts`.
- [ ] **Step 4:** Run the test, then `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit** "A business knows what it owns".

### Task 2: The vault's own key, and refusing card numbers

**Files:**
- Create: `packages/db/src/vault-crypto.ts` (export from index)
- Create: `packages/shared/src/card-number.ts` (export from index)
- Test: `apps/api/test/the-vault-has-its-own-key.test.mjs`

**Interfaces:**
- Produces: `vaultConfigured(): boolean`; `sealVaultSecret(plain: string): string` (throws `VAULT_NOT_CONFIGURED` when key missing/short); `openVaultSecret(sealed: string): string`; `looksLikeCardNumber(text: string): boolean`.

- [ ] **Step 1: Failing tests (run for real):** with `NEXUS_VAULT_KEY` = 40 chars, seal→open round-trips "p@ss w0rd!"; two seals of the same text differ (random IV); with the key unset, `sealVaultSecret` throws `/VAULT_NOT_CONFIGURED/` and `vaultConfigured()` is false — even when `NEXUS_TOKEN_KEY` and `NEXUS_SESSION_SECRET` are set; a sealed value from a different key fails to open. `looksLikeCardNumber("4111 1111 1111 1111")` true, `("4111-1111-1111-1112")` false (Luhn), `("+971 52 563 1476")` false, `("myPass2026")` false.
- [ ] **Step 2:** Run. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement with the same AES-256-GCM `iv:tag:ct` format as `token-crypto.ts`, key = sha256(NEXUS_VAULT_KEY), no fallback; card check strips spaces/dashes, 13–19 digits, Luhn.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** "The vault has its own key and refuses card numbers".

### Task 3: Pure HQ logic — health, staleness, provider, hostname

**Files:**
- Create: `packages/shared/src/hq.ts` (export from index)
- Test: `apps/api/test/a-business-health-score.test.mjs`

**Interfaces:**
- Produces:
  - `type HqSeverity = "critical" | "warning" | "notice"`; `interface HqIssue { code: string; severity: HqSeverity; title: string; fix: string }`
  - `scoreHealth(issues: HqIssue[]): number`
  - `hqIssues(state: HqState, now: Date): HqIssue[]` where `HqState` = latest checks + profile + keywords + socials + vault entries (ages only)
  - `staleness(lastAt: string | null, maxDays: number, now: Date): "fresh" | "stale" | "never"`
  - `normalizeBusinessHost(websiteUrl: string): { host: string; registrable: string } | null` — rejects IPs, ports, `localhost`, single-label and `.local/.internal` names
  - `detectProvider(input: { nameservers: string[]; ip: string | null; ptr: string | null; headers: Record<string,string> }): { provider: string; behindProxy: boolean }`

- [ ] **Step 1: Failing tests (run for real):**
  - `scoreHealth([critical, warning, notice])` = 62; ten criticals = 0; `[]` = 100.
  - `hqIssues` with SSL valid-to 5 days ahead → one `critical` "SSL expires in 5 days"; 15 days → `warning`; domain 10 days → critical; 25 days → warning; http `ok:false` → critical "Site is down"; speed mobile 45 → warning, 65 → notice; rdap `ok:null` → notice "Could not check domain expiry" (never absent); GBP last post 9 days → notice; vault entry changed 200 days ago → notice; social without 2FA → notice.
  - `normalizeBusinessHost("https://www.sfsintrealestate.com/")` → `{host:"www.sfsintrealestate.com", registrable:"sfsintrealestate.com"}`; `("https://jurisprimelegal.ae")` → registrable `jurisprimelegal.ae`; `("http://10.0.0.5")`, `("https://localhost:3000")`, `("https://api.internal")`, `("https://example.com:8080")` → null.
  - `detectProvider` with nameservers `["ns1.dns-parking.com"]` → Hostinger; `["kai.ns.cloudflare.com"]` + `headers.server="cloudflare"` → `{provider:"Behind Cloudflare (real host hidden)", behindProxy:true}`; `headers["x-shopid"]` or ptr `*.myshopify.com` → Shopify; ptr `*.vercel-dns.com` / header `x-vercel-id` → Vercel; unknown → the ptr host, else the IP, else "Unknown".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; thresholds exactly as Global Constraints. Registrable domain: last two labels, or last three when the second-last is one of `co|com|net|org|gov|ac` under a 2-letter TLD (`example.co.uk`).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** "A business's health is a number with reasons".

### Task 4: The checks — parsers and the runner

**Files:**
- Create: `apps/api/src/services/hq-checks.ts`
- Create: `apps/api/test/fixtures/hq/wordpress-home.html`, `shopify-home.html`, `bare-home.html` (small saved pages)
- Test: `apps/api/test/the-website-is-checked.test.mjs`

**Interfaces:**
- Consumes: Task 1 `recordHqCheck`, Task 3 `normalizeBusinessHost`, `detectProvider`.
- Produces: `parseSeoSignals(html: string): { title: string|null; titleLength: number; metaDescription: string|null; h1Count: number; noindex: boolean; canonical: string|null; jsonLd: boolean }`; `detectPlatform(html: string, headers: Record<string,string>): string | null`; `parseRdap(json: unknown): { registrar: string|null; expiresAt: string|null }`; `runHqChecks(org: { id: string; websiteUrl: string | null }, deps?: Partial<HqCheckDeps>): Promise<Record<HqCheckKind, { ok: boolean|null; data: unknown; error: string|null }>>`, where `HqCheckDeps = { fetch; resolveNs; resolve4; reverse; tlsValidTo }` is injectable for tests.

- [ ] **Step 1: Failing tests (real):** `parseSeoSignals` on each fixture (WordPress: title + description + 1 h1 + JSON-LD; bare: no description, noindex true); `detectPlatform` → "WordPress" (`wp-content`), "Shopify" (`cdn.shopify.com`), null for bare; `parseRdap` on a saved rdap.org sample → registrar + expiry from the `expiration` event. `runHqChecks` with injected deps where RDAP returns 404 → `rdap.ok === null` and the other six kinds still have results; PageSpeed dep throws after timeout → `speed.ok === null`; a websiteUrl of `http://127.0.0.1` → every kind `ok:null`, error "Not a public website address", no fetch made.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Each check its own `Promise.allSettled` branch with `AbortSignal.timeout(10_000)` (PageSpeed 60_000). RDAP `https://rdap.org/domain/<registrable>`; PageSpeed `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=mobile|desktop&category=performance` (+ `&key=` when `PAGESPEED_API_KEY`); TLS via `node:tls` connect `servername:host`, `getPeerCertificate().valid_to`; robots.txt and sitemap.xml fetched from the host as part of `seo`. Persist each result with `recordHqCheck` when not in a test (deps passed ⇒ persist still called; tests inject a fake recorder through deps).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** "The website is checked, and an unanswerable check says so".

### Task 5: Daily job and "Check now"

**Files:**
- Create: `apps/api/src/queue/hq-checks-queue.ts`, `apps/api/src/queue/hq-checks-processor.ts`
- Modify: `apps/api/src/worker.ts` (worker + `scheduleHqChecks()`), `packages/shared` `ScheduledJob` list (add `"hq-checks"` with a 26 h stall window, so `/health/jobs` watches it)
- Test: `apps/api/test/checks-run-every-morning.test.mjs`

**Interfaces:**
- Produces: `HQ_CHECKS_QUEUE = "hq-checks"`; `scheduleHqChecks(): Promise<void>` (repeat pattern `0 6 * * *`, `tz: "Asia/Dubai"`); `enqueueHqCheckNow(orgId: string): Promise<"queued" | "too-soon">` (Redis `hq:checknow:<orgId>` `EX 300 NX`).

- Also produces `notifyOwnersOfHqCritical(orgName: string, issues: HqIssue[]): Promise<void>` in `apps/api/src/services/push-dispatcher.ts`: for each critical issue, Redis `push:hq:<orgId>:<code>` `EX 86400 NX`, then owner devices via `buildPlatformPayload` + `deliver` (no-op when `!pushConfigured()`).
- [ ] **Step 1: Failing tests:** pins on the repeat pattern + tz; processor wraps in `withJobHeartbeat("hq-checks", …)`; skips `review-demo` and inactive orgs; `enqueueHqCheckNow` uses `"EX", 300, "NX"`; the processor calls `notifyOwnersOfHqCritical` with only `severity === "critical"` issues; its dedupe key uses `"EX", 86400, "NX"`.
- [ ] **Step 2–4:** Run (FAIL) → implement → run + `check.sh` (PASS).
- [ ] **Step 5: Commit** "Every business is checked every morning".

### Task 6: The vault — unlock, reveal, edit

**Files:**
- Create: `apps/api/src/services/vault-unlock.ts`
- Test: `apps/api/test/the-vault-opens-for-its-owner-only.test.mjs`

**Interfaces:**
- Consumes: `verifySecret` (`@nexus/employees`), `findAdminById`, Task 1/2 functions, Redis `getRedisConnection()`.
- Produces: `unlockVault(adminId: string, password: string): Promise<{ ok: true; expiresInSeconds: 300 } | { ok: false; reason: "wrong-password" | "locked-out"; retryInSeconds?: number }>`; `vaultUnlockedFor(adminId): Promise<number>` (seconds left, 0 = locked); `lockVault(adminId)`; `revealVaultSecret({orgId, entryId, adminId, ip, userAgent}): Promise<{ ok: true; secret: string } | { ok: false; status: 401 | 404 | 503; error: string }>`.

- [ ] **Step 1: Failing tests (real, with an in-memory Redis stand-in passed as a dep):** correct password → ok, `vaultUnlockedFor` 300; wrong ×5 → 6th attempt `locked-out` even with the right password, `retryInSeconds` ≤ 900; reveal with no unlock → 401 "Unlock again", and `recordVaultReveal` NOT called; reveal while unlocked → secret returned and `recordVaultReveal` called once with ip/userAgent; vault not configured → 503 "The vault key is not set on the server."; entry of another business id → 404.
- [ ] **Step 2–4:** Run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** "The vault opens only for its owner, and remembers who looked".

### Task 7: The HQ API

**Files:**
- Create: `apps/api/src/routes/hq.ts`; mount `app.route("/api/hq", hqRoute)` with `app.use("/api/hq", operatorOnly)` and `app.use("/api/hq/*", operatorOnly)` in `apps/api/src/index.ts`
- Test: `apps/api/test/business-hq-is-for-admins.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces (JSON):
  - `GET /api/hq` → `{ businesses: { slug, name, logoUrl, score, topIssues: HqIssue[] }[] }` sorted by score asc
  - `GET /api/hq/:slug` → `{ business, profile, checks, issues, score, keywords, socials, vault: VaultEntryPublic[], reveals, vaultConfigured, unlockedSeconds }`
  - `PUT /api/hq/:slug/profile`; `POST|PUT|DELETE /api/hq/:slug/keywords[/:id]`; `POST|PUT|DELETE /api/hq/:slug/socials[/:id]`
  - `POST|PUT|DELETE /api/hq/:slug/vault[/:id]` (secret accepted on write only while unlocked; any field failing `looksLikeCardNumber` → 422 "Card numbers do not belong here — use a payment manager.")
  - `POST /api/hq/unlock {password}` → 200 / 401 / 429; `POST /api/hq/lock`; `POST /api/hq/:slug/vault/:id/reveal` → `{ secret }`
  - `POST /api/hq/:slug/check` → 202 `{ queued: true }` | 429 "Checked less than 5 minutes ago."
- `GET /api/hq/:slug` pre-fills `socials` with Facebook/Instagram rows from `social_connections` (handle = display_name, url from the platform) when no `hq_social_accounts` row exists for that platform, flagged `source: "connected"`.
- [ ] **Step 1: Failing tests:** pins: both `operatorOnly` mounts present before the route; the business handler reads `social_connections` for `facebook`/`instagram` and marks `source: "connected"`; no handler JSON contains `secret_enc`/`secretSealed`; the reveal handler reads `x-forwarded-for` and `user-agent`; card refusal message exact; `review-demo` filtered from `GET /api/hq`; unlock reads the admin id from the session scope (`scope.adminId`), never the body.
- [ ] **Step 2–4:** Run (FAIL) → implement → run + `check.sh` (PASS).
- [ ] **Step 5: Commit** "Business HQ answers admins and nobody else".

### Task 8: The overview page and the nav item

**Files:**
- Create: `apps/web/app/deck/hq/page.tsx`, `apps/web/app/deck/hq/hq.css`
- Modify: `apps/web/app/console-shell.tsx` (NAV item `{ href: "/deck/hq", label: "Business HQ", operatorOnly: true }`), `apps/web/lib/api.ts` (`getHqOverview()`, `getHqBusiness(slug)` and the write calls)
- Test: `apps/web/test/business-hq-overview.test.mjs`

**Interfaces:** Consumes Task 7's responses.

- [ ] **Step 1: Failing tests:** render the card list from a fixture response: worst score first, score ring text "62", the top issue title, card links to `/deck/hq/sfs-international`; the NAV item is `operatorOnly`; the API helper paths are `/api/hq` literals.
- [ ] **Step 2–4:** Run (FAIL) → implement (score ring colour: ≥ 80 good, 50–79 warn, < 50 crit, using `--good/--warn/--crit`) → run (PASS).
- [ ] **Step 5: Commit** "Every business on one screen, worst first".

### Task 9: One business — five tabs and the vault UI

**Files:**
- Create: `apps/web/app/deck/hq/[slug]/page.tsx`, `apps/web/app/deck/hq/[slug]/vault-panel.tsx`, `apps/web/app/deck/hq/[slug]/tabs.tsx`
- Test: `apps/web/test/one-business-hq.test.mjs`

- [ ] **Step 1: Failing tests (render with fixtures):** tab labels "Overview", "Website & domain", "SEO & Google", "Social media", "Vault & access log"; an `ok:null` check renders "Could not check" (not a tick); vault rows render "••••••••" and no secret text from the fixture; with `vaultConfigured:false` the vault shows "The vault key is not set on the server."; the reveal handler schedules a hide after 30_000 ms (pin); saving a changed domain in the profile form calls the check endpoint right after (pin); a stale keyword renders the amber "stale" chip; a 200-day password renders "changed 200 days ago".
- [ ] **Step 2–4:** Run (FAIL) → implement (unlock dialog with password field, countdown, "Lock now"; reveal/copy buttons; inline edit forms; "Check now" button showing the 429 text) → run + `check.sh` (PASS).
- [ ] **Step 5: Commit** "One business, everything it owns, and a vault that locks itself".

### Task 10: Ship

- [ ] **Step 1:** Generate `NEXUS_VAULT_KEY` (48 random chars) and append to `/opt/nexus/.env` (owner approved the setup step in the spec review). Apply migration 097 as owner via psql.
- [ ] **Step 2:** `bash scripts/mirror.sh`, deploy. Expected: `PASS - all three running images were built from <sha>`.
- [ ] **Step 3:** `POST /api/hq/<slug>/check` for the five businesses (or run the processor once in the worker). Expected: `hq_checks` has rows of all seven kinds for each; record which came back `ok:null` and why.
- [ ] **Step 4:** In the browser as the owner: `/deck/hq` shows five cards; open SFS International; every tab renders real data; unlock with a wrong password shows the error; (owner performs the real unlock and first entry). As staff: `/deck/hq` is not in the nav and `/api/hq` answers 403.
- [ ] **Step 5:** Run `./scripts/verify-all.sh`. Expected: 12/12 PASS (schema-drift sees 097 applied).
