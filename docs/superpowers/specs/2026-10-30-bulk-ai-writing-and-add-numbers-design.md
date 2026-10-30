# Bulk messaging: AI writing and adding numbers — design

30 Oct 2026. The owner asked, for the admin bulk messaging: AI "will help us to
compose what kind of message will deliver to client", a tab "to add bulk clients
number in the campaign", and "manual add client number", all "reliable and
creative". The design was approved in chat on 30 Oct with these choices:

- **Where:** the admin Bulk messaging page (`/deck/bulk`). Campaigns
  (`/deck/broadcasts`) and the staff pages stay as they are.
- **What AI writes:** Quick messages, and new approved messages that the admin
  sends to WhatsApp for approval from the page.
- **The three sections below** were approved as presented: adding numbers,
  AI writing, new approved messages.

## Why now

Bulk messaging became the admins' alone on 30 Oct (69152e0). An admin can only
reach people already in Nexus and writes every word alone. The only way to bring
in a list is the Customers page import, which leaves the campaign and ticks
nobody. Staff used to write new approved messages; since bulk moved to the
admins nobody can, so a list of new numbers can only get the approved messages
that already exist.

## The WhatsApp rule that shapes this

Free text (a Quick message) reaches only people who wrote to the sending number
in the last 24 hours. Numbers added here have never written, so WhatsApp lets
them get **an approved message only**. The page says so wherever it matters.
AI writing for approved messages is what lets new numbers get new wording.

## What the owner gets

### 1. "+ Add numbers" (step 2, Customers)

Step 2 gets two tabs: **Pick customers** (today's list) and **+ Add numbers**.

- **Three ways in, one panel:**
  - **Paste a list.** One per line, or separated by commas or semicolons;
    "Ahmed 050 123 4567", "+971 50 123 4567 Ahmed"; a column pasted from Excel;
    spaces, dashes, dots and brackets ignored.
  - **Upload a file.** Excel (.xlsx) or CSV, read by the Customers import's
    reader (`lib/xlsx-read.ts`). The number and name columns are guessed and
    shown; the admin can change them.
  - **Type one at a time.** Number and optional name; Enter adds it to the list
    and clears the box for the next.
- **Country.** UAE (+971) by default, changeable (UAE, Saudi Arabia, Oman,
  Qatar, Bahrain, Kuwait, India, Pakistan, Philippines, UK). A local number is
  completed with it and shown corrected: "050 123 4567 → +971 50 123 4567".
  Nothing is completed silently.
- **Check list before anything is saved**, live as the admin types, each row
  with its outcome and counts at the top
  ("38 ready · 3 corrected · 2 already customers · 1 duplicate · 1 refused"):
  - **Ready:** already in international form.
  - **Corrected:** completed from the country; shows from → to.
  - **Already a customer:** not added again, just ticked.
  - **Duplicate:** appears earlier in the list; kept once.
  - **Refused:** not a phone number (letters, too short, too long), or local
    with no way to complete it.
  - After adding, the server can also refuse **Asked not to be messaged** (an
    opt-out with any business).
- **Consent.** A required tick: "These people agreed to get WhatsApp messages
  from {business}." The Add button stays disabled until it is ticked. WhatsApp
  requires opt-in, and spam reports cost the number its rating.
- **Add.** Sends the ready and corrected rows, up to 2000 at a time. Every row
  comes back with its own outcome; nothing is dropped silently; adding the same
  list twice adds nobody twice.
- **Where they go.** Customers of the business, through the same path as the
  Customers import (`ensureContactForServingBusiness`). When the campaign sends
  from a staff member's number, people with no book yet go into that person's
  book (`assignContactOwnerIfUnowned`), so their replies reach that person.
  Someone already in another person's book stays there, and the row says so.
- **Afterwards.** The customer list reloads, the added and already-known people
  are ticked, a **Just added** chip shows only them, and step 3 opens on
  Approved with: "These 41 have never written to this number, so WhatsApp lets
  them get an approved message only."

### 2. ✨ Write with AI (Quick message and new approved message)

- **A brief** ("weekend viewings at Dubai Hills, reply to book") and optional
  chips: Friendly | Professional · Short | Detailed · English | Arabic.
- **Three drafts** that take different approaches (for example direct, warm,
  question-led), shown as WhatsApp bubbles with the first ticked customer's
  first name filled in, with a character count.
- **Use this** puts a draft in the editor. On the editor's text: **Shorter**,
  **More formal**, **Arabic version**.
- **What the AI is told:** the business's name, tagline and summary
  (`organizations.tagline`, `organizations.summary`); that it is a WhatsApp
  message from a business to its own customers; use `{name}` for the first
  name; never invent prices, dates, offers, links or phone numbers that are not
  in the brief; no all-capitals, at most two emoji. Quick drafts stay under 600
  characters. Approved drafts stay under 1024, never start or end with
  `{name}`, use no other placeholder, add no link unless the brief has one, and
  say nothing about opting out (the Stop button does that).
- **The AI never sends.** Drafts are suggestions in an editor the admin can
  change, and the existing review step still comes before any send.
- **AI unavailable:** "The AI is not available right now — write the message
  yourself." The editor keeps working.
- **Limit:** 30 AI requests per admin per hour, kept in the API process like the
  test-send limit, so a stuck button cannot run up a bill.

### 3. New approved messages (step 3, Approved)

- Under the message picker: **✨ Write a new approved message**. Draft with AI
  or type, give it a short name ("weekend viewings"), language from the chip.
- **Send to WhatsApp for approval** submits it on the chosen number's WhatsApp
  account with that account's token (`tokenFor`): category MARKETING, a Stop
  quick-reply button ("Stop" / "إيقاف"), `{name}` becoming `{{1}}` with an
  example. This is the submission staff used (`createMetaTemplate`,
  `staffTemplateBody`).
- **The name carries the business:** `bulk_<code>_<label>`, with a fixed code
  per business: zipicka → `zp`, sfs-international → `sfs`, juris-prime → `jp`,
  juris-prime-legal → `jpl`, abr → `abr`. `templateOwnerSlug` learns the
  pattern, so `attributeTemplate` answers "own" for that business and
  "other-business" for every other: a message written for SFS is never offered
  to Zipicka on the shared WhatsApp account. A `bulk_` name with an unknown code
  belongs to nobody here and is offered to no business. (A plain new name would
  be "unattributed", which is offered to every business.)
- **Waiting list** under the picker: "Waiting for WhatsApp: weekend viewings ·
  sent 2 min ago" with **Check again**. Check again asks WhatsApp for that
  template's status and reason (`GET /{template-id}?fields=status,rejected_reason`)
  and re-syncs the number's templates. It also runs by itself when a number
  with waiting messages is opened (only then, so opening a number with none
  waiting costs no extra call to WhatsApp). Once approved, the message moves
  into the picker and is selected.
- **Refused:** WhatsApp's reason in a sentence (for example "WhatsApp read it as
  too promotional for its rules") and **Ask AI to fix it**, which rewrites the
  text with that reason. Resubmitting needs a new name, because WhatsApp keeps
  refused names.
- **Same name twice:** "There is already a message with that name — choose
  another."

## Not in this change

- **No "is this number on WhatsApp" check before sending.** The Cloud API has
  none; a number not on WhatsApp fails on send with "This person is not on
  WhatsApp.", in the campaign's results as today.
- **No images, headers or extra buttons** in new approved messages.
- **No scheduled sends, and no cost estimate per country.**
- **Consent is confirmed per batch and written to the log** (who, business,
  number, how many). There is no consent column per contact; that needs a
  migration and is worth adding only if WhatsApp ever asks for proof.
- **No new database tables or migrations.**

## API (all under `/api/bulk`, which `operatorOnly` already guards)

| Route | What it does |
|---|---|
| `POST /api/bulk/:slug/customers` | Body `{ phoneNumberId, consent: true, rows: [{ waId, displayName?, line? }] }`. Refuses the whole request without consent (400) or above 2000 rows (400). Each `waId` must be international digits: 8 to 15 digits, not starting with 0. The page completes local numbers; the server never guesses. Opted-out numbers are refused ("asked not to be messaged"). Returns one result per row `{ line, waId, outcome: "added" \| "already-known" \| "refused", reason?, contactId? }` and the counts. Staff-number sends place unowned contacts in that person's book. Logs actor, business, number, counts and consent. |
| `POST /api/bulk/:slug/write` | Body `{ kind: "quick" \| "approved", brief, tone?, length?, language? }`. Brief up to 500 characters. Returns `{ drafts: string[] }` (three). 503 when the AI is unavailable, 429 above the hourly limit. |
| `POST /api/bulk/:slug/rewrite` | Body `{ kind, text, change: "shorter" \| "formal" \| "arabic" \| "fix", reason? }`. Returns `{ text }`. Same 503 and 429. |
| `POST /api/bulk/:slug/number/:phoneNumberId/templates` | Body `{ label, language, text }`. Submits as above. Returns `{ name, status }`; 422 with WhatsApp's reason when it refuses. |
| `POST /api/bulk/:slug/number/:phoneNumberId/templates/refresh` | Checks the waiting messages and re-syncs; returns the number view. |
| `GET /api/bulk/:slug/number/:phoneNumberId` (existing) | Adds `pending: [{ id, name, label, language, status, reason, createdAt }]`: this business's `bulk_` messages on the number's account that are not approved yet. |

## AI

- **Where:** `apps/api/src/lib/message-writer.ts`. Prompt assembly, the call and
  draft parsing are separate parts, so everything but the model call is tested
  without the model.
- **Model:** Claude, through `completeText` in `packages/agents`, which gains an
  optional `model` (and effort) for this caller. The writer uses
  `claude-opus-5-5`, overridable with `NEXUS_WRITER_MODEL`. Effort low.
  Server-side refusal fallback on (`fallbacks: "default"`). `max_tokens` 4000,
  because Opus 5.5 always thinks and its thinking counts toward the cap. The
  other `completeText` callers keep their model.
- **Format:** drafts come back separated by a line holding only `---`, parsed
  strictly: numbering and quotation marks stripped, empty drafts dropped. Fewer
  than three usable drafts still returns the ones that are; none is a 503.
- **Cost:** about 3 US cents per "Write with AI" (Opus 5.5 is $4 / $20 per
  million tokens; about 1,000 in and 1,500 out including thinking).
- **SDK:** `@anthropic-ai/sdk` is 0.32.1, older than the effort and fallback
  fields. They are sent as body fields on the same `messages.create` call, with
  the beta header passed as a request header. If that proves brittle, upgrading
  the SDK in `packages/agents` is its own change.

## Web

- `apps/web/lib/phone-list.ts`: the number reader. Pure functions:
  `readPhoneList(text, country)` returns rows with outcomes; also used by the
  one-at-a-time box. Country table: dialling code, the local trunk "0", and
  number lengths (UAE: 9 digits after 971).
- `apps/web/app/deck/bulk/add-numbers.tsx`: the tab (paste, file, one at a
  time, country, check list, consent, Add).
- `apps/web/app/deck/bulk/ai-writer.tsx`: brief, chips, drafts, Use this, the
  quick rewrites. Used by Quick message and by new approved messages.
- `apps/web/app/deck/bulk/new-approved.tsx`: write, submit, waiting list,
  refused.
- `ClientsTab` gains an optional **Just added** chip (ids passed in);
  `QuickMessage` gains an optional slot for the writer. Both stay shared with
  the staff pages and unchanged there.
- Styles in `bulk.css`, using the tokens in `deck.css`.

## Errors, all in sentences on the page

- AI unavailable or over the limit: says which, editor unaffected.
- A number refused: the row says why; the rest still add.
- No consent: the Add button stays disabled; the server refuses too.
- WhatsApp refuses a new message: its reason, and Ask AI to fix it.
- The number's token cannot write messages (a staff connection without a stored
  key): "This number's WhatsApp connection cannot submit messages. Ask its owner
  to reconnect it in Connections."

## Testing

- **Number reader (web tests):** UAE local forms (050…, 50…, 00971…, +971…,
  971…); spaces, dashes, dots, brackets; names before and after; commas and
  semicolons; duplicates; too short and too long; another default country; one
  number typed alone.
- **Writer (API tests):** the prompt carries the business name, tagline and the
  rules; parsing handles separators, numbering, quotes and fewer than three;
  approved drafts are checked for `{name}` at the start or end.
- **Naming:** `bulk_<code>_<label>`; `templateOwnerSlug` maps each code;
  `attributeTemplate` is "own" for the business and "other-business" for the
  rest; an unknown code is offered to nobody.
- **Routes:** everything under `/api/bulk` stays admin-only; the customers route
  refuses without consent, refuses local and opted-out numbers, caps at 2000,
  and assigns to a book only when unowned; the writer is rate-limited; new
  messages are named with the business code and submitted with `tokenFor`.
- **Local preview** against the mock API, then the full test suite.
- **Live, after deploy:** add the owner's own test number through the tab and
  draft with AI (about 3 US cents). Submitting a message to WhatsApp for
  approval is outward-facing, so it is asked for first.

## Rollout

No migration and no new required setting (`NEXUS_WRITER_MODEL` is optional).
Deployed with `scripts/deploy.sh` once the owner says so.
