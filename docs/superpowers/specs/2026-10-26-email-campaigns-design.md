# Email campaigns, kept apart from WhatsApp campaigns — design

26 Oct 2026. The owner asked for bulk messaging "separated for email and
WhatsApp", and for it to be creative and reliable. The design was approved in chat
on 26 Oct with these choices:

- **Sender:** the staff member's own mailbox, otherwise the business mailbox.
- **Content:** free text, with `{name}` for the customer's first name.
- **Scope:** both staff and admin.

## Why now

Ralph's only campaign (22 Oct) was queued to 57 people, and all of them were
email-only customers. WhatsApp refused 14 of them ("The parameter to is
required") and the safety stop paused the rest. The audience was corrected that
day to WhatsApp-only, so today email customers can't be reached by any campaign.

Staff books are mostly email: Ralph has 14 WhatsApp clients and 61 email clients.

## What the owner gets

1. Each campaign page has a **WhatsApp / Email** switch:
   - staff: My campaigns
   - admin: Campaigns

   Each campaign goes out on exactly one channel. The page shows how many people
   each channel can reach before anything is chosen, e.g.
   "14 on WhatsApp · 61 by email".
2. **WhatsApp campaigns are unchanged.** They use approved Meta templates and
   reach people with a WhatsApp number.
3. **Email campaigns** have:
   - a subject and a message, written in Nexus;
   - `{name}` for the first name, which becomes "there" when no name is known;
   - **Polish** to tidy wording without adding facts;
   - a live preview;
   - **Send me a test**;
   - a plan line before sending: "61 today", or "300 today, 120 tomorrow".
4. **Each email is one-to-one**, never CC or BCC. It joins the customer's email
   conversation in the inbox, so a reply lands where every other email lands.
5. **Unsubscribe.** Every campaign email carries a footer link and a one-click
   `List-Unsubscribe` header. Clicking it, or replying "unsubscribe" or "stop",
   opts the customer out of email campaigns only.
6. **Bounces.** "Address not found" mail is matched back to the recipient. The
   recipient is marked failed, and the address is skipped by every later
   campaign.
7. **Paused campaigns** (either channel) get **Resume** and **Stop**.
8. **The creative bit.** After a WhatsApp send, the page says: "61 clients have
   email only — send them an email version?" This opens the email form with a
   subject already filled.

## Not in this change

- **Customer lists stay WhatsApp-only.** An admin email campaign goes to
  everyone the business can reach by email.
- **No scheduled sending.** Campaigns send now; only the daily-limit spill goes
  to the next day.
- **No images or attachments,** and no open or click tracking. Tracking pixels
  hurt deliverability and privacy, and nothing here needs them.

## Data (migration 103-email-campaigns.sql)

**`broadcasts`**
- `channel text not null default 'whatsapp'`, checked to be `whatsapp` or
  `email`.
- `template_id` becomes nullable. A check requires it for whatsapp, and requires
  `email_subject` and `email_body` for email.
- New columns:
  - `email_subject text`, `email_body text`
  - `from_mailbox text` (the address, stamped at send)
  - `from_mailbox_employee_id uuid` (whose connection; null means the business
    mailbox)
- The status check gains `stopped`.

**`broadcast_recipients`**
- `to_address text` — the email address frozen at queue time.
- `email_message_id text` — the RFC Message-ID or the Gmail id.
- `send_after timestamptz` — when a recipient spilled to a later day.
- `unsubscribe_token uuid not null default gen_random_uuid()`, unique.
- An index on (`to_address`, `sent_at`) for bounce matching.

**`contacts`**
- `email_campaigns_opted_out_at timestamptz`
- `email_bounced_at timestamptz`

The migration is applied as the owner, after a pg_dump backup, before the code is
deployed. Every new column is nullable or has a default, so the code running
before the deploy keeps working.

## Who an email campaign reaches

A customer's address is `lower(attributes->>'email')`, and it must look like
`x@y.z`. The base rule matches the WhatsApp one: the business serves the
customer, and they are not marked Not a customer. On top of that they must:

- have a valid address;
- not be email-opted-out;
- not be bounced.

Two audiences use it:

- **Staff:** the customers they own (`contactOwnedBy`), via
  `myClientsForEmailCampaign`.
- **Admin:** every customer the business serves, via `businessEmailAudience`.

A customer who said STOP on WhatsApp (`reengagement_opted_out`) is excluded from
email campaigns too. Stop means stop.

## Which mailbox sends

`resolveCampaignMailbox(organizationId, employeeId | null)`:

- **Staff:**
  1. their own usable IMAP connection, else
  2. their own Gmail, else
  3. the business IMAP mailbox, else
  4. refuse: "No mailbox to send from — connect yours in Connections, or ask the
     owner to connect the business mailbox in Channels."
- **Admin:** the business IMAP mailbox, else refuse with the Channels hint.

The send goes out on the existing transports, extended:

- `sendEmailImap` takes `html` and extra `headers`.
- `sendGmail` builds a multipart/alternative message (text and HTML) with extra
  headers.
- Both return the id they already return. Replies are untouched.

## Rendering

`renderCampaignEmail({ subject, body, name, unsubscribeUrl, businessName })`
returns `{ subject, text, html }`.

- `{name}` is replaced in the subject and body. Any other braces are left as
  typed.
- **Text version:** the body, plus "—", plus "Don't want these emails?
  Unsubscribe: URL".
- **HTML version:** escaped paragraphs, links made clickable, a small grey footer
  with an Unsubscribe link, the business name, and no images.
- **Headers:**
  - `List-Unsubscribe: <URL>` (and `mailto:` with the subject `unsubscribe`)
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`

The unsubscribe URL is `{apiBaseUrl()}/unsubscribe/{token}`. It is served by the
API outside `/api` with no cookie, like `/links`:

- **GET** shows a small page with a button.
- **POST** (the button, or a one-click client) opts the customer out and shows
  "You're unsubscribed".
- An unknown token gets the same reply ("You're unsubscribed"), so a token
  reveals nothing.

## Sending

**Queue and pace**
- A new queue, `email-broadcast-send`, with a worker at concurrency 1 and a
  limiter of 1 job per 3 s (about 1,200 an hour across all mailboxes).
- Retries: 4 attempts with exponential backoff from 30 s.

**Daily limit**
- `EMAIL_CAMPAIGN_DAILY_CAP` per mailbox, default 300 in any rolling 24 hours,
  counted from `broadcast_recipients` sent from that `from_mailbox`.
- At send time the route splits the audience: up to the remaining limit today,
  the rest in 24-hour blocks.
- Spilled recipients get `send_after` and a matching job `delay`.
- The plan is returned and shown before sending, from a dry-run endpoint, so
  "300 today, 120 tomorrow" is known before anything is sent.

**The processor** (`email-broadcast-processor.ts`), for each recipient:
1. Do nothing if the campaign is paused or stopped. The recipient stays
   pending.
2. Re-check the contact. If they unsubscribed or bounced since queueing, mark
   them failed: "Unsubscribed before it was sent" or "Address bounced
   earlier".
3. Render the email and send it from the stamped mailbox.
4. Mark the recipient sent and store the message id.
5. Record the email in the customer's email conversation (created if missing),
   as an outbound row with dedup on the message id. The sweep then never stores
   it twice.

**Errors**
- **Transient** (network, timeout, SMTP 421/45x, Gmail 429 or 5xx): rethrown so
  the queue retries.
- **Permanent** (SMTP 5xx recipient errors, a malformed address): the recipient
  is marked failed with a plain-words reason.
- **Mailbox sign-in failure** (SMTP 535, Gmail invalid_grant or reconnect): the
  campaign pauses at once, because every recipient would fail the same way. The
  reason is "The mailbox sign-in stopped working — reconnect it, then Resume."

**Safety stop:** the existing `pauseBroadcastIfFailing` runs after every
recipient, the same as WhatsApp.

## Bounces and email opt-out from replies

In the inbox sweep, before automated mail is skipped:

- **Bounces:** mail from `mailer-daemon`/`postmaster`, or with a delivery-failure
  subject, is read for addresses. Each address is matched to a campaign recipient
  sent from that same mailbox in the last 7 days. The match is marked failed
  ("Bounced: the address does not exist or refused the email") and the contact
  gets `email_bounced_at`. If the 7-day bounce rate pushes the breaker over, the
  campaign pauses.
- **Unsubscribe replies:** an inbound email from a customer whose fresh part
  matches the existing `looksLikeAnOptOut` gets `email_campaigns_opted_out_at`.
  The mail is still stored as a normal message.

## Resume and Stop (both channels)

**Endpoints**
- Staff: `POST /api/my/campaigns/:id/resume|stop`, own campaigns only.
- Operator: `POST /api/broadcasts/:id/resume|stop`, for any business campaign or
  staff campaign.

**Resume**
- Only from `paused`. It sets `sending` and re-queues every pending recipient
  from the database.
- **WhatsApp:** the template and number come from the broadcast row; the WhatsApp
  number comes from the contact, re-checked to be non-empty.
- **Email:** the mailbox is checked to still be usable before resuming.

**Stop**
- From `paused` or `sending`, it sets `stopped`. Pending recipients stay pending
  and are shown as "not sent". The processor skips them.

## Small fixes in the same change

- `explainSendError` learns:
  - "The parameter to is required" → "This customer has no WhatsApp number
    (email only)."
  - The email errors above.
- The WhatsApp processor marks a recipient with an empty number failed without
  calling Meta.
- Ralph's 22 Oct campaign (`paused`, 43 pending, all email-only) is set to
  `stopped` after deploy, with the new Stop action.
- `listBroadcasts` changes its template join to `left join`, so email campaigns
  appear in the admin history.

## Screens

**My campaigns (staff)**
- Channel tabs at the top: **WhatsApp (14)** and **Email (61)**.
- The WhatsApp tab is today's form.
- The Email tab has:
  - From line ("From ralph@… (your mailbox)")
  - subject; message with a `{name}` chip; Polish
  - preview card showing the first recipient's name
  - plan line
  - "Send me a test" (address prefilled with their own mailbox)
  - "Send to 61"
- **History:** a channel icon on each row; for email, sent / failed / bounced /
  unsubscribed counts and the explained reasons. Paused rows get Resume and Stop.
- **After a WhatsApp send:** the "email version" prompt.

**Campaigns (admin)**
- The same switch.
- The Email tab sends to "Everyone reachable by email (N)" from the business
  mailbox, or says that no mailbox is connected.
- History shows the channel, and Resume / Stop.

The pages follow the deck tokens and existing campaign styles. No new colours.

## Testing

**Unit** (node:test, the repo's source-reading style plus pure functions)
- render: `{name}` and the "there" fallback, HTML escaping, the footer, the
  headers
- the daily-limit split (pure function)
- the error classifier: transient, permanent, auth
- bounce address extraction
- opt-out detection on email
- `explainSendError` additions

**Guards**
- Audience SQL excludes: opted-out, bounced, Not a customer, invalid address,
  other people's customers.
- The unsubscribe route is public, only under `/unsubscribe`, and reveals
  nothing for an unknown token.
- Staff resume/stop compare `employee_id`.
- Operator routes stay behind `operatorOnly`.

**Live (read-only first)**
- A dry run on the server that sends nothing, for Ralph and Keshav: audience
  sizes, mailbox, plan.
- Then one real test email, only to an address the owner gives.

## Done means

- Migration applied.
- `check.sh` green, apart from the known mirror.sh line.
- Deployed: all three images on the new commit.
- The dry run is correct.
- Ralph's dead campaign is stopped.
- The pages render at desktop and phone width with customer data visible only to
  the right people.
