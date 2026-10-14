# Business HQ — per-business admin dashboard and credential vault

**Status:** design approved in conversation 2026-10-14 ("yes approved all"); this document awaits written review.
**Requested by:** the owner — "a specific dashboard for each business that only admin can access … website domain, hosting, user name and password, current SEO / GMB / keyword if updated or not … a tab for social media pages user and password … make it smart and creative."

## 1. Intent

One place per business that answers, at a glance: *what does this business own online, who hosts it, how do we get in, and what is about to break or has gone stale.* Today that knowledge lives in sticky notes and memory (passwords were visible on desktop notes on 12 Oct). Success means:

- an admin opens a business and sees every login, domain, hosting and social account it has, with passwords protected;
- Nexus itself notices expiring domains and certificates, a site that is down or slow, and SEO/Google/social work nobody has updated — and says so before it costs anything;
- nothing here is visible to staff, and every password reveal is accounted for.

## 2. Decisions taken (owner, 2026-10-14)

| Question | Decision |
|---|---|
| Passwords | **Locked vault**: encrypted in Nexus; shown as dots; revealing or copying needs the admin's own password; every reveal logged |
| Who | **Every admin** (today Ralph Ivan Simeon, Atif Ali; any added later). Each unlocks with their own password |
| SEO data | **Automatic checks + manual notes** with staleness. Google Search Console / Business Profile API connections are a later phase, not this one |
| Where | **Inside Nexus**, owner-only area "Business HQ" |
| Defaults ("approve all") | Unlock lasts **5 minutes**; **5 wrong passwords lock unlocking for 15 minutes**; passwords flagged after **180 days** unchanged; vault uses **its own encryption key** |

Out of scope: staff access; Google API integrations; storing payment cards or bank details (refused by design — §5.6); auto-changing passwords on third-party sites.

## 3. Pages

**Nav:** one `operatorOnly` item, "Business HQ", in the console rail. Staff never receive the link, the page, or the API (all routes behind `operatorOnly`).

### 3.1 `/deck/hq` — all businesses
One card per active business (review-demo excluded): name, logo, **health score 0–100**, and its top three "needs you" items. Sorted worst-first so the business needing attention is at the top.

### 3.2 `/deck/hq/[slug]` — one business, five tabs

**Overview.** Health score with its breakdown; the full "Needs you" list (each item says what, why, and what to do); quick facts (domain, host, platform, last check time).

**Website & domain.**
- Automatic, checked daily (and on demand with "Check now"):
  - domain registrar and expiry date — RDAP (`https://rdap.org/domain/<domain>`), no key needed;
  - hosting — DNS nameservers + A record, resolved to a provider name by a small known-provider table (Hostinger, Cloudflare, Shopify, Vercel, GoDaddy, Wix, Squarespace, AWS, Google), else the raw host;
  - SSL — TLS handshake on 443: issuer, valid-to date;
  - up/down + response time — HTTPS GET of the homepage;
  - speed score (mobile, desktop) — Google PageSpeed Insights API v5 (works without a key at low volume; `PAGESPEED_API_KEY` used if set);
  - platform — detected from the homepage (WordPress, Shopify, Wix, Next.js, etc.).
- Vault entries: domain registrar, hosting / cPanel, website admin (WordPress etc.), business email.
- Typing or changing the domain fills the automatic fields immediately ("Check now").

**SEO & Google.**
- Automatic (daily): homepage `<title>` and meta description (present, length), one `<h1>`, `robots.txt` reachable and not blocking `/`, `sitemap.xml` reachable, `noindex` absent, JSON-LD structured data present, canonical tag.
- Manual, each with "last updated" and a staleness colour:
  - **Target keywords**: keyword, current Google position, date checked (stale after 30 days);
  - **Google Business Profile**: profile link, rating, review count, date of last post (stale after 7 days), last photo (stale after 30 days), unanswered reviews count.

**Social media.** One card per platform (Facebook, Instagram, TikTok, LinkedIn, YouTube, X, Snapchat, Google Business, Other): handle, profile link, followers, last post date (stale after 14 days), 2FA on/off, recovery email/phone, and its login in the vault. For Facebook/Instagram pages already connected to Nexus, the handle and link are pre-filled from the connection.

**Vault & access log.** Every vault entry of this business: label, service, username, URL, password (dots), notes, password age ("changed 210 days ago" — amber after 180). Below it, the reveal log: who, what entry, when, from which device/IP, newest first.

## 4. Health score

Starts at 100; each open issue subtracts by severity — critical 25, warning 10, notice 3 — floor 0. Issues:

| Issue | Severity |
|---|---|
| Site down / not HTTPS-reachable | critical |
| Domain expires ≤ 14 days, or SSL ≤ 7 days | critical |
| Domain expires ≤ 30 days, or SSL ≤ 21 days | warning |
| Mobile speed score < 50 | warning (< 70 notice) |
| Missing title / meta description / sitemap / robots blocks site / noindex | warning |
| No structured data, no H1, no canonical | notice |
| GBP last post > 7 days, keywords not checked > 30 days, social last post > 14 days | notice |
| Password unchanged > 180 days, social account without 2FA | notice |
| An automatic check could not run (DNS/RDAP/PSI error) | notice ("could not check", never counted as passing) |

A check that could not run is shown as unknown, not green.

## 5. The vault

### 5.1 Storage
`hq_vault_entries`: id, organization_id, section (`website` | `social` | `other`), service, label, username, url, notes, `secret_enc` (sealed), `secret_changed_at`, created_by, updated_by, timestamps. The password is the only sealed field; usernames, URLs and notes are plain so they can be searched and shown.

### 5.2 Encryption
AES-256-GCM via the existing `sealToken`/`openToken` construction, but keyed by a **new `NEXUS_VAULT_KEY`** (≥ 32 chars, in `/opt/nexus/.env`). Unlike the token key there is **no fallback**: without `NEXUS_VAULT_KEY` the vault refuses to save or reveal and the page says so plainly. A dump of the database alone reveals nothing; a leak of the token key or session secret does not open the vault.

### 5.3 Unlock
- "Unlock" asks the signed-in admin for **their own password**, verified with the same scrypt check and the same Redis login throttle as admin sign-in.
- Success opens a **5-minute unlock window** for that admin session, stored server-side in Redis (`hq:unlock:<adminId>`, `EX 300`) — not in a cookie, not in the browser.
- **5 wrong passwords lock unlocking for 15 minutes** (Redis counter `hq:unlock-fail:<adminId>`).
- The page shows the remaining unlock time; "Lock now" ends it.

### 5.4 Reveal
- `GET` of entries never returns a password. Revealing one is a separate `POST /api/hq/vault/:id/reveal` that requires an open unlock window and returns that one password.
- Every reveal (and every copy, which is a reveal) writes `hq_vault_reveals`: entry, admin, time, IP, user agent. Revealed text is hidden again after 30 seconds on screen.
- Passwords never appear in logs, errors, analytics, or the service worker cache (`/api/` is already excluded by `sw.js`).

### 5.5 Editing
Creating or changing a password requires an open unlock window too, and stamps `secret_changed_at`. Deleting an entry asks for confirmation; it is a soft delete (`deleted_at`) so the reveal log stays readable.

### 5.6 What the vault refuses
Fields that look like payment card numbers (Luhn-valid 13–19 digits) are rejected in every field with a message pointing to a payment manager.

## 6. Data model (migration 097)

- `hq_profiles` — one row per organization: domain, registrar, hosting_note, platform_note, gbp_url, gbp_rating, gbp_review_count, gbp_last_post_at, gbp_last_photo_at, gbp_unanswered_reviews, updated_at/by.
- `hq_keywords` — organization_id, keyword, position, checked_at.
- `hq_social_accounts` — organization_id, platform, handle, url, followers, last_post_at, two_factor, recovery_contact, vault_entry_id (nullable), updated_at/by.
- `hq_vault_entries` — §5.1; `hq_vault_reveals` — §5.4.
- `hq_checks` — organization_id, kind, ran_at, ok, data jsonb, error; the latest per kind is the current state; history kept 90 days.

All tables: RLS tenant policy like every table since the RLS pass; all API access is operator-only and cross-tenant through `withAllTenants` with named reasons. Domain prefilled from `organizations.website_url`.

## 7. Background checks

A `hq-checks` BullMQ job in the worker, **daily at 06:00 Asia/Dubai**, plus "Check now" (rate-limited to once per 5 minutes per business). Each check runs independently with a timeout so one slow host never blocks the rest. Results go to `hq_checks`; the health score is computed on read. When phone alerts are on (mobile plan, Phase 2), a check that turns a business critical sends one owner alert per issue per day, reusing the platform-alert path.

## 8. Security review points

- Every route behind `operatorOnly`; tested by pinning the route list.
- No password in any list response; reveal only with a live unlock window; tested.
- Reveal log written in the same transaction as the read.
- `NEXUS_VAULT_KEY` required, separate from `NEXUS_TOKEN_KEY` and the session secret.
- Outbound checks only to the business's own domain and the fixed APIs (RDAP, PSI) — no user-supplied URL is fetched other than the business domain, which is validated as a hostname (no IPs, no ports, no internal hosts) to rule out server-side request forgery.

## 9. Testing

Pure functions tested for real: health scoring, staleness, provider detection, hostname validation, card-number rejection, SEO page parsing (against saved HTML). Text pins for route guards, vault response shape, reveal logging, and key requirement. A live check against the five real domains after deploy, recorded in the plan's verification step.

## 10. Rollout

1. Migration 097 (owner, psql) and `NEXUS_VAULT_KEY` in `.env` before the code deploys.
2. Deploy; run "Check now" for all five businesses; confirm each tab populates from real data.
3. The owner moves passwords in from wherever they are kept today (the desktop sticky notes can then be deleted).
