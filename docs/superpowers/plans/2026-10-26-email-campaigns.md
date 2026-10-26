# Email campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff and admins can send a bulk campaign by email, kept separate from WhatsApp campaigns. The email channel is reliable:
- daily limit with next-day spill
- unsubscribe
- bounce handling
- pause / resume / stop

**Architecture:**
- **Shared base:** one `broadcasts` table gains a `channel`. Email campaigns reuse its recipients, history and breaker.
- **Own pieces:**
  - audience SQL
  - mailbox resolver
  - renderer
  - queue (`email-broadcast-send`)
  - processor
- **Sending:** goes out on the existing Gmail and SMTP transports, extended with an HTML part and headers.
- **Unsubscribe:** a public API route, outside `/api`, like `/links`.

**Tech Stack:** Hono, Postgres (RLS, `withTenant`), BullMQ, nodemailer, Gmail REST, Next.js, node:test with tsx.

**Spec:** `docs/superpowers/specs/2026-10-26-email-campaigns-design.md`

## Global Constraints

- Migration file: `packages/db/migrations/103-email-campaigns.sql`. Apply it as the owner after a pg_dump, before deploying the code. It must be additive: no new non-null column without a default.
- Channel values: `whatsapp` | `email`. New broadcast status: `stopped`.
- Daily cap: env `EMAIL_CAMPAIGN_DAILY_CAP`, default `300` per mailbox, counted over a rolling 24 h.
- Queue: `email-broadcast-send`. Worker concurrency 1, limiter `{ max: 1, duration: 3000 }`. Attempts 4, exponential backoff 30 000 ms.
- Unsubscribe URL: `${apiBaseUrl()}/unsubscribe/${token}`. Headers:
  - `List-Unsubscribe: <URL>, <mailto:ADDRESS?subject=unsubscribe>`
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- Footer copy: text `Don't want these emails? Unsubscribe: URL`; HTML link text `Unsubscribe`.
- `{name}` → first word of the display name, else `there`.
- Copy, verbatim:
  - no mailbox (staff): "No mailbox to send from — connect yours in Connections, or ask the owner to connect the business mailbox in Channels."
  - mailbox sign-in failure: "The mailbox sign-in stopped working — reconnect it, then Resume."
- CSS uses only deck tokens (see `a-token-that-does-not-exist-renders-as-nothing.test.mjs`).
- Tests: `apps/api/test/*.test.mjs`. They may import `.ts` via tsx. Run with `node --import tsx --test <file>`.
- Every staff route resolves the person through `deskOf(c)` and never accepts an employee id from the caller.

## Review Focus

1. **Contact with an email in `attributes.email` but a WhatsApp chat as well.** They are in both audiences; one campaign per channel, never duplicated within one. Test: the audience SQL has no join that multiplies rows (`select distinct` or a single-table predicate).
2. **Campaign larger than the remaining daily cap when the cap is already used up.** Everything spills to later days; nothing is refused. Test: `splitByDailyCap(10, 0, 300)` → today 0, all at +24 h.
3. **Mailbox password changed mid-campaign.** The first auth failure pauses the campaign, rather than failing 300 people one by one. Test: the classifier maps `535` and `invalid_grant` to `auth`, and the processor source pauses on `auth`.
4. **Customer unsubscribes between queueing and sending.** Re-checked at send time and not emailed. Test: the processor source re-reads opt-out before sending.
5. **Name containing `<script>` or `&`.** Escaped in HTML, unchanged in text. Test: in the render tests.

---

### Task 1: Migration and shared types

**Files:**
- Create: `packages/db/migrations/103-email-campaigns.sql`
- Modify: `packages/shared/src/types.ts` (BroadcastStatus, new types)
- Test: `apps/api/test/a-campaign-goes-by-email-or-whatsapp.test.mjs`

**Interfaces:**
- Produces:
  - `type BroadcastChannel = "whatsapp" | "email"`
  - `BroadcastStatus` gains `"stopped"`
  - `interface EmailBroadcastSendJob { broadcastId: string; recipientId: string }`

  The processor reads everything else fresh from the database.

- [ ] Test (source-reading). The migration:
  - adds `channel` with check `('whatsapp','email')` and default `'whatsapp'`
  - drops not-null on `template_id`
  - adds check `broadcasts_channel_content_check`
  - re-adds `broadcasts_status_check` including `'stopped'`
  - adds the recipient columns `to_address`, `email_message_id`, `send_after`, `unsubscribe_token` (unique, default `gen_random_uuid()`)
  - adds the contact columns `email_campaigns_opted_out_at`, `email_bounced_at`

  The types file exports `BroadcastChannel` and `EmailBroadcastSendJob`.
- [ ] Run → fail. Write the migration and types. Run → pass.
- [ ] Commit.

### Task 2: Database functions

**Files:**
- Create: `packages/db/src/email-campaigns.ts`, exported from `packages/db/src/index.ts`
- Modify:
  - `packages/db/src/broadcasts.ts`: `listBroadcasts` uses a left join and returns `channel`, `emailSubject`; `BroadcastRow` gains `channel`; `getBroadcast` selects `channel`, `employee_id`, `email_subject`, `email_body`, `from_mailbox`, `from_mailbox_employee_id`, `from_phone_number_id`
  - `packages/db/src/client-book.ts`: `listMyBroadcasts` returns `channel`, `emailSubject`, `bounced`, `unsubscribed`, `notSent`
- Test: same test file as Task 1 (source assertions on SQL)

**Interfaces** (produces, all in `email-campaigns.ts`):
- `EMAIL_ADDRESS_SQL` — the expression `lower(nullif(trim(ct.attributes->>'email'),''))`.
- `emailReachableSql(alias = "ct")` — the shared predicate:
  - address matches `'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'`
  - `email_campaigns_opted_out_at is null`
  - `email_bounced_at is null`
  - `reengagement_opted_out = false`
  - `not_a_customer_at is null`
- `myClientsForEmailCampaign(orgId, employeeId): Promise<Array<{ id; email; displayName }>>` — served, owned by them, reachable.
- `businessEmailAudience(orgId)` — same shape; served and reachable.
- `createEmailBroadcast({ organizationId, employeeId: string | null, subject, body, fromMailbox, fromMailboxEmployeeId: string | null }): Promise<{ id }>` — status `sending`, channel `email`.
- `createEmailRecipients(broadcastId, rows: Array<{ contactId; toAddress; sendAfter: Date | null }>): Promise<Array<{ id; contactId; sendAfter }>>`
- `emailSentFromMailbox24h(fromMailbox): Promise<number>` — recipients with `status in ('sent','delivered')` and `sent_at > now() - interval '24 hours'`, joined to broadcasts on `from_mailbox`.
- `emailRecipientForSend(recipientId)` — returns:
  - `{ broadcastId, status, campaignStatus, toAddress, contactId, displayName, optedOut, bounced, subject, body, fromMailbox, fromMailboxEmployeeId, organizationId, unsubscribeToken, businessName }`
  - or null.
- `markEmailRecipientSent(recipientId, messageId)` and `markEmailRecipientFailed(recipientId, reason)`.
- `optOutOfEmailCampaigns(contactId)` and `unsubscribeByToken(token): Promise<boolean>`. Both set `email_campaigns_opted_out_at = coalesce(existing, now())`. The token path runs as a stated `withAllTenants`.
- `recordEmailBounce(fromMailbox, address): Promise<{ broadcastId } | null>` — finds the newest recipient sent to that address from that mailbox within 7 days, marks it failed with "Bounced: the address does not exist or refused the email", and sets `contacts.email_bounced_at`.
- `pendingRecipients(broadcastId): Promise<Array<{ id; contactId; waId: string | null; displayName; toAddress }>>`
- `setBroadcastStatusIf(broadcastId, from: BroadcastStatus[], to: BroadcastStatus): Promise<boolean>`

- [ ] Test: the source asserts each predicate above appears in `emailReachableSql`, and that the staff audience uses `contactOwnedBy`. Also, `listBroadcasts` uses `left join message_templates`.
- [ ] Implement. Run the tests. Commit.

### Task 3: Rendering, the daily split, the error classifier, bounce parsing

**Files:**
- Create: `apps/api/src/lib/campaign-email.ts`
- Test: `apps/api/test/an-email-campaign-is-personal-and-polite.test.mjs`

**Interfaces** (produces):
- `firstName(displayName: string | null): string` → first word, or `"there"`.
- `renderCampaignEmail({ subject, body, displayName, unsubscribeUrl, businessName, fromAddress }): { subject: string; text: string; html: string; headers: Record<string, string> }`
- `splitByDailyCap(count: number, usedToday: number, cap: number): number[]` — the number of recipients for day 0, 1, 2, ….
- `classifyEmailSendError(err: unknown): "transient" | "permanent" | "auth"`
- `explainEmailSendError(err: unknown): string`
- `bounceAddresses(mail: { from: string | null; subject: string | null; body: string }): string[]` — empty unless the sender matches `mailer-daemon|postmaster`, or the subject matches `/undeliver|delivery status notification|delivery has failed|returned mail|failure notice/i`.

- [ ] Tests:
  - **render:** `{name}` → "Ralph" in both subject and body; null name → "there"; `<b>&` escaped in the HTML, raw in the text; the text ends with `Don't want these emails? Unsubscribe: https://x/unsubscribe/t`; the headers equal the Global Constraints.
  - **split:**
    - `splitByDailyCap(61, 0, 300)` → `[61]`
    - `(420, 0, 300)` → `[300, 120]`
    - `(10, 300, 300)` → `[0, 10]`
    - `(0, 0, 300)` → `[]`
  - **classify:**
    - `{ responseCode: 535 }` → auth
    - `Error("GMAIL_RECONNECT …")` → auth
    - `Error("invalid_grant")` → auth
    - `{ responseCode: 421 }` → transient
    - `{ code: "ETIMEDOUT" }` → transient
    - `Error("HTTP 503")` → transient
    - `{ responseCode: 550 }` → permanent
  - **bounceAddresses:** a mailer-daemon mail containing `jo@x.com` → `["jo@x.com"]`; an ordinary customer mail → `[]`.
- [ ] Run → fail. Implement. Run → pass. Commit.

### Task 4: Transports and the mailbox resolver

**Files:**
- Modify:
  - `apps/api/src/lib/gmail.ts`: `sendGmail` input gains `html?: string | null` and `headers?: Record<string, string>`. With html it builds `multipart/alternative` (text and html, both base64). The single-part path stays unchanged.
  - `apps/api/src/lib/imap-email.ts`: `sendEmailImap` input gains `html?` and `headers?`, passed to nodemailer.
- Create: `apps/api/src/services/campaign-mailbox.ts`
- Test: `apps/api/test/a-campaign-goes-by-email-or-whatsapp.test.mjs` (source assertions)

**Interfaces** (produces):
- `resolveCampaignMailbox(organizationId, employeeId: string | null): Promise<{ address: string; provider: "imap" | "gmail"; employeeId: string | null } | { error: string }>`
  - Staff order: own IMAP, own Gmail, business IMAP.
  - Admin: business IMAP only.
  - Uses `listConnections(...).usable`.
- `sendFromMailbox(organizationId, mailbox: { address; provider; employeeId }, msg: { to; subject; text; html; headers }): Promise<string>` — returns the message id.
  - IMAP: `connectionSecret` then `sendEmailImap`.
  - Gmail: `gmailToken` then `sendGmail`.

- [ ] Test (source): the resolver tries `imap` personal, then `gmail` personal, then the business `imap`; the error copy is verbatim; `sendGmail` contains `multipart/alternative` only inside an `if (input.html)` branch.
- [ ] Implement. Run. Commit.

### Task 5: Queue, processor and worker

**Files:**
- Create: `apps/api/src/queue/email-broadcast-queue.ts` (`getEmailBroadcastQueue()`, name `email-broadcast-send`)
- Create: `apps/api/src/queue/email-broadcast-processor.ts` (`processEmailBroadcastJob(job)`)
- Modify:
  - `apps/api/src/worker.ts`: register the worker with the Global Constraints settings
  - `apps/api/src/queue/broadcast-processor.ts`: an empty `contactWaId` → mark failed "This customer has no WhatsApp number (email only)." without calling Meta; skip when the status is `stopped`
  - `apps/api/src/lib/send-errors.ts`: map the message `The parameter to is required` to the same sentence
- Test: `apps/api/test/an-email-campaign-is-personal-and-polite.test.mjs` (add source assertions)

Processor order:
1. `emailRecipientForSend`
2. return if the campaign is `paused` or `stopped`, or the recipient is not pending
3. if opted out or bounced → failed ("Unsubscribed before it was sent" / "Address bounced earlier")
4. render and send via `sendFromMailbox`
5. `markEmailRecipientSent`
6. record in the conversation: `findOrCreateEmailContact`-free path. Use the contact id directly: `findOrCreateEmailConversation(org, contactId, null)`, then `insertSyncedEmailMessage` outbound with body `${subject}\n\n${text}` and the message id.

On error:
- transient → rethrow until the last attempt, then failed
- auth → `setBroadcastStatusIf(id, ["sending"], "paused")`, leave the recipient pending, log the copy
- permanent → failed with `explainEmailSendError`

Then `pauseBroadcastIfFailing` and the finish logic, the same as WhatsApp: completed or failed when nothing is pending and the campaign is not paused or stopped.

- [ ] Test (source): the processor reads the status before sending; re-checks `optedOut` and `bounced`; pauses on `auth`; calls `pauseBroadcastIfFailing`. The WhatsApp processor checks the empty number before `sendWhatsAppTemplate`. `explainSendError('…"message":"The parameter to is required."…')` → the sentence.
- [ ] Implement. Run. Commit.

### Task 6: Routes — staff, admin, resume/stop, polish

**Files:**
- Modify: `apps/api/src/routes/my-campaigns.ts`
- Modify: `apps/api/src/routes/broadcasts.ts`
- Create: `apps/api/src/services/email-campaign-send.ts` — `queueEmailCampaign({ organizationId, employeeId, subject, body, audience, mailbox })` returns `{ broadcastId, plan: number[] }`. It is shared by both routes:
  - computes the split
  - creates the broadcast and recipients with `send_after`
  - adds jobs with `delay = day * 86_400_000`
  - `planEmailCampaign(count, mailboxAddress)` returns `number[]` without writing anything.
- Create: `apps/api/src/services/campaign-control.ts` — `resumeCampaign(broadcastId)` and `stopCampaign(broadcastId)`. Resume re-queues pending recipients for either channel. WhatsApp jobs are rebuilt from `getBroadcast` + template + `pendingRecipients` (skipping an empty `waId` → failed). Email jobs need only ids.
- Test: `apps/api/test/a-campaign-goes-by-email-or-whatsapp.test.mjs`

**Endpoints:**
- `GET /api/my/campaigns` adds `email: { reachable, from: string | null, fromError: string | null, plan: number[], audience: [{ displayName, email }] }`
- `POST /api/my/campaigns/email` `{ subject ≤ 200, body ≤ 10 000 }`
  - Checks, in order: `canBroadcast`, reachable > 0, mailbox, subject and body non-empty.
  - Returns `{ broadcastId, plan }`.
- `POST /api/my/campaigns/email/test` `{ subject, body, to }`
  - `to` must be a valid address.
  - Rate-limited with the existing `takeTestSend`.
  - Renders with the sender's own name and sends one email. Writes no rows.
- `POST /api/my/campaigns/polish` `{ text }` — `completeText`, the polish prompt plus "Keep {name} exactly as written". 2 000-character limit.
- `POST /api/my/campaigns/:id/resume` and `/:id/stop` — the broadcast's `employee_id` must equal `desk.employeeId`, compared literally, else 404.
- `GET /api/broadcasts/:slug` adds `email: { reachable, from, fromError, plan }`
- `POST /api/broadcasts/:slug/email` `{ subject, body }` — `employeeId` null.
- `POST /api/broadcasts/:id/resume` and `/:id/stop`

- [ ] Test (source):
  - the staff resume/stop compare `employee_id` against `desk.employeeId`
  - the email send refuses when `fromError`
  - the test send never calls `createEmailBroadcast`
  - polish includes `{name}`
  - the admin routes sit under `/api/broadcasts` (`operatorOnly` already)
- [ ] Implement. Run the tests, plus the existing campaign tests (`a-campaign-*`). Commit.

### Task 7: Unsubscribe page and sweep hooks

**Files:**
- Create: `apps/api/src/routes/unsubscribe.ts` (`unsubscribeRoute`):
  - `GET /:token` → HTML page with a POST form
  - `POST /:token` → `unsubscribeByToken`, then the "You're unsubscribed" page
  - Both always 200. The token must be a uuid, else the same page.
- Modify: `apps/api/src/index.ts`: `app.route("/unsubscribe", unsubscribeRoute)` next to `/links`. No auth, no cors needed.
- Modify: `apps/api/src/services/email-sync.ts` `storeInboxMail`:
  - before the automated-skip, `bounceAddresses(m)`. For each address → `recordEmailBounce(ownerAddress, addr)`, then `pauseBroadcastIfFailing` on the returned broadcast.
  - for a stored inbound customer mail whose fresh part `looksLikeAnOptOut` → `optOutOfEmailCampaigns(contactId)`.
- Test: `apps/api/test/an-email-campaign-is-personal-and-polite.test.mjs`
  - the route file has no `requireAuth`
  - the index mounts `/unsubscribe` outside `/api`
  - an unknown token's response equals the success page (same function)
  - `storeInboxMail` calls `bounceAddresses` before `isAutomatedMail`, and uses `looksLikeAnOptOut`

- [ ] Implement. Run. Commit.

### Task 8: Web — client, My campaigns, admin Campaigns

**Files:**
- Modify: `apps/web/lib/api.ts`: types and calls for the endpoints in Task 6.
- Create: `apps/web/app/deck/my-campaigns/email-campaign.tsx` (`EmailCampaignForm`, shared by both pages via props `{ reachable, from, fromError, plan, onSend, onTest, onPolish, sampleName }`).
- Create: `apps/web/app/deck/campaign-controls.tsx` (`CampaignControls`: Resume/Stop buttons for a paused or sending row).
- Modify:
  - `apps/web/app/deck/my-campaigns/page.tsx`: channel tabs with counts, the email tab, history (channel icon, email counts, controls), and the "email version" prompt after a WhatsApp send.
  - `apps/web/app/deck/broadcasts/page.tsx`: the same tabs, an email tab sending to "Everyone reachable by email (N)", and history with the channel and controls.
  - `apps/web/app/deck/my-campaigns/my-campaigns.css` and `apps/web/app/deck/broadcasts/broadcasts.css`: tokens only.
- Test: `apps/api/test/a-campaign-goes-by-email-or-whatsapp.test.mjs`
  - both pages render `EmailCampaignForm`
  - the form shows the plan line
  - the Send button text includes the reachable count
  - the token test passes

- [ ] Implement. Run the token and screen tests. Commit.

### Task 9: Verify, deploy, live checks

- [ ] `./scripts/check.sh`. The only accepted failure is "mirror.sh is itself executable"; read the `/tmp` log for the full list.
- [ ] On the VPS:
  - pg_dump
  - apply 103 as owner
  - push
  - `deploy.sh`
  - confirm all three images are on the new commit
- [ ] Stop Ralph's 22 Oct campaign with `stopCampaign`, in a one-off script on the worker. Confirm its status is `stopped`.
- [ ] Read-only dry run, for Ralph and Keshav (and the business mailboxes): email reachable, mailbox, plan.
- [ ] Browser: My campaigns as admin is not possible, so check the admin Campaigns page at desktop and phone width. Customer names in the audience are blurred only in recordings; normal use shows them.
- [ ] Ask the owner for an address before any real test email.
