# Your own message to every chosen customer — design

**Date:** 3 Nov 2026. **Branch:** `bulk-own-message`, cut from `main` at `f005af3` (live).
**Status:** approved under the owner's standing instruction to take Claude's recommendation.

## What the owner asked

"As an admin we can do our own message for all clients; the AI agent also helps us compose those
messages to them."

## What is there today (checked on the live site, 3 Nov 2026)

On `/deck/bulk` the admin chooses the business, the sending number and the customers, then a
message:
- An **approved message** (a WhatsApp template) can go to everyone.
- A **quick message** in the admin's own words can go only to people who wrote in the last 24
  hours. That is Meta's rule, not ours: 2 of Zipicka's 49 customers today.
- **"✨ Write a new approved message"** lets the admin write their own words, or ask "✨ Write with
  AI" for three drafts, and send them to WhatsApp for approval.

The pieces exist. What does not work for a person:

1. **Five separate steps.** An own message for everyone means: write → send for approval → wait →
   come back later → pick it → review → send. Nothing on the server reacts when Meta approves it.
   The template sync (every 30 min) and "Check again" only update the list.
2. **A refusal looks like a draft.** When the AI declines a brief that does not fit the business, its
   explanation comes back as one "draft" with **Use this**. `completeText` and `parseDrafts` have
   no notion of a refusal, so the API answers 200 `{drafts: ["<refusal>"]}`.
3. **Drafts show a real client's name unlabelled.** The preview puts the first chosen customer's
   first name in place of `{name}` ("Hi Work…"). Use this inserts `{name}` correctly, but nothing
   says the preview is one person's view.
4. **The approved-message picker shows code names.** It shows `bulk_<code>_weekend_viewings (en)`,
   although `bulkTemplateLabel` already turns those into the admin's own short name.

## Design

### 1. Send when approved

**API.** `POST /api/bulk/:slug/number/:phoneNumberId/templates` (`admin-bulk-templates.ts`) takes an
optional `sendTo: string[]` of contact ids, the customers ticked on the page. When it is present
and the template was created:
- the audience is resolved exactly as `POST /:slug/send` resolves it (the business's
  `getContactsForAudience` filtered to the chosen ids, max as there);
- a campaign is created with `createAdminBroadcast`, plus its recipients;
- the campaign's status is set to **`scheduled`** and its `scheduled_at` is left null, meaning
  "goes out when WhatsApp approves its message";
- the answer adds `{ waiting: { broadcastId, recipients } }`.

No migration: `scheduled` is already an allowed status and nothing else creates one with
`template_id` pointing at a pending template.

**Release.** A new `releaseApprovedCampaigns(organizationId)` in
`apps/api/src/services/campaign-control.ts`, next to `resumeCampaign`. For each of the business's
campaigns with status `scheduled`, `scheduled_at` null and a template:
- **template now approved:** claim the campaign with
  `setBroadcastStatusIf(id, ['scheduled'], 'sending')` (so two releases never both send), then queue
  each pending recipient exactly as the send route does (same job data, `staffTemplateParams` for
  the first name). The queueing is shared with `resumeCampaign`, not copied.
- **template rejected, disabled, paused or deleted:** set the campaign to `failed`. The waiting list
  already shows WhatsApp's reason, with "Ask AI to fix it".
- **still pending:** leave it.

Release is called:
- by the template sync job after each business's sync (`syncAllTemplates`);
- by `POST …/templates/refresh` ("Check again", and the page's own refresh).

So an approval is acted on within 30 minutes, or straight away when the admin presses "Check again".

**The send job.** `processBroadcastSendJob` treats a campaign still `scheduled` like a missing one:
it throws, so the queue retries and nothing is sent until the campaign is `sending`.

**Cancel.** A waiting campaign shows in "Recent campaigns" as **Waiting for WhatsApp approval**,
with a **Cancel** button that calls the existing stop route (`campaign-control.stopCampaign`
already moves `scheduled` to `stopped`).

**Web.** In the "Write a new approved message" panel, with customers chosen:
- the main button reads **Send for approval, then send to N customers**;
- a quieter **Only send for approval** keeps today's behaviour;
- one sentence under the buttons says WhatsApp usually decides within minutes to a day, that the
  message goes out to the N customers automatically once it is approved, and that it can be
  cancelled while it waits.

With nobody chosen, only "Send to WhatsApp for approval" shows, as today.

### 2. A refusal is a note, never a draft

The writer's system prompt (`writerSystemPrompt`, `apps/api/src/lib/message-writer.ts`) gains one
rule: when the brief does not fit the business or cannot be written honestly, reply with a single
line `CANNOT: <reason>` and nothing else.

`writeDrafts` and `rewriteDraft` return `{ drafts: [], note: "<reason>" }` for such a reply. The
route answers `{ drafts: [], note }`, and the web shows the note as a sentence with no Use this.
A reply that is one chunk, shorter than the drafts asked for, that is not a usable message is
treated the same way, so a model that ignores the rule still cannot hand the admin a refusal as a
draft.

### 3. The preview says whose view it is

Above the drafts, when a sample name is used: **"As {first name} would see it — each customer gets
their own name."** The same line shows under the message preview in the panel.

### 4. The picker shows the admin's own words

The approved-message picker labels `bulk_` templates with `bulkTemplateLabel(name)` and other
templates with their name, underscores turned into spaces. The language stays in brackets.

## Out of scope

- Sending to customers on other businesses' numbers.
- A per-campaign schedule time ("send on Friday at 9").
- Meta's template-status webhook. Polling every 30 minutes plus "Check again" is enough for now.
- The staff side (`/deck/my-campaigns`). It shares helpers, but its flow is unchanged.

## Testing

Each test is watched failing first.

**API, against the throwaway Postgres, with Redis and Meta stood in:**
- creating a template with `sendTo` makes a `scheduled` campaign with one pending recipient per
  chosen customer, and queues nothing;
- release with the template still pending changes nothing;
- release with it approved makes the campaign `sending` and queues one job per pending recipient;
- a second release queues nothing more;
- release with it rejected makes the campaign `failed`;
- a send job for a `scheduled` campaign throws and sends nothing.

**Writer.** A `CANNOT:` reply becomes `{drafts: [], note}`; a lone non-message chunk also becomes a
note; three normal drafts are unchanged.

**Web.**
- the picker label for a `bulk_` name is its short name;
- the panel shows the "then send to N customers" button only with customers chosen;
- a note renders without Use this;
- the preview line names the sample customer.
