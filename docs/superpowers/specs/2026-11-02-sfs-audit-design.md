# SFS workflow audit — a live page inside Nexus (design)

2 November 2026. Approved section by section in conversation; this document is
the written spec for review.

## 1. Purpose and decisions

The boss of SFS International (Dubai real estate) drew an "SFS AI Agent
Workflow": 20 steps in two lanes, supply (owner → live listing) and demand
(lead → closed deal), seven AI agents and human/compliance gates. Source:
the Design canvas https://claude.ai/artifact/TdXvEuFSJM9WFS6NzHCsvy (read-only;
this project never writes to it).

This page puts that workflow inside Nexus, live, and audits it against what
Nexus actually does and records for SFS.

Decisions taken with the owner:

- **Lives inside Nexus, live** — not a static picture.
- **Every number from Nexus's real SFS data.** Nothing invented, nothing typed
  in. Where Nexus records nothing, the page says so.
- **Audit first, then performance.** The workflow with each step's honest
  status on top; SFS's performance charts below.
- **Period:** 7 / 30 / 90-day pills switch everything together; opens on 30.
- **Steps Nexus does not track** are shown greyed, "Not tracked in Nexus yet",
  with what tracking them would need. No inputs, no manual statuses.
- **Who sees it:** admins (any business with a workflow) and **all SFS staff**,
  who see the **whole SFS team's** figures. No colleague's individual numbers
  are listed by name anywhere on the page.
- **Approach A:** one read-only audit endpoint, one pure status-rules module,
  one page on the Cream kit. No new table, no migration.

## 2. Where it lives and who reaches it

- The page: **`/deck/workflow`**, titled "Workflow audit · SFS International".
- **Admins** reach it from a "Workflow audit" link on Business HQ → SFS
  International (shown only on businesses that have a workflow). On the page,
  a business switcher lists the businesses with a workflow — today only SFS.
- **Staff** whose business has a workflow (today: SFS staff) get a "Workflow
  audit" item in their sidebar. Staff of other businesses get no item.
- The server enforces it: the endpoint sits under
  `/api/organizations/:slug/…`, behind the existing `requireTenantScope`
  guard — admins any business, staff only their own; staff asking for another
  business get the guard's existing 403 "You don't have access to that
  business."

## 3. The page, top to bottom

1. **Header.** Title, the business, the 7 / 30 / 90 pills, and a one-line
   verdict counted from the statuses: e.g. "4 working · 0 idle · 5 partly ·
   11 not tracked in Nexus yet".
2. **The workflow** (§4) — two lanes of cards with arrows.
3. **Six number tiles and five chart cards** (§5).
4. **Dubai compliance checklist** (§6).

Cream kit throughout (NumberTile, StatusCard, ChartCard, AreaChart, BarChart,
CardWindow, kit tables and pills), Warm Night and phone-ready like the part 2a
pages. Every figure and chart states the days it covers.

## 4. The workflow

### 4.1 Statuses

Each step has a fixed **coverage** (what Nexus does for it, declared in code)
and, where it has one, **activity** (counted from data for the period).

| Status | Card | Rule |
|---|---|---|
| Working | forest (green) | coverage "built" and activity > 0 in the period |
| Idle | paper, forest outline | coverage "built" and activity = 0 in the period |
| Partly | mustard | coverage "partly" — Nexus covers part; the card says which part. Its figures show; with none in the period it says "nothing in this period" |
| Not tracked | dashed, muted | coverage "not tracked" — the card says what tracking it would need. No figures |

The verdict line counts cards by status.

### 4.2 The 20 steps

Tag, name and subtitle are the boss's, unchanged. "Evidence" is what the card
and its window show for the period; "Link" is the screen holding the detail.

**Supply — owner to live listing**

| # | Tag | Step (boss's subtitle) | Coverage | Evidence / what is missing | Link |
|---|---|---|---|---|---|
| S1 | SOURCE | Owner database (CRM, past clients, referrals) | partly | Contacts in total; added in the period; with a lead source recorded. Missing: which contacts are property owners. | Customers |
| S2 | AGENT 01 | Data filter (dedupe, verify consent, score) | partly | One contact per number (structural); opted out of re-engagement; marked "not a customer"; contacts scored in the period. Missing: consent captured for owner outreach. | Customers |
| S3 | AGENT 02 | WhatsApp + AI call (template msg, voice follow-up) | partly | Broadcast messages sent / delivered / failed; calls logged by outcome (answered, no answer, voicemail, busy, failed). Missing: AI voice calls — calls are logged by people. | Broadcast |
| S4 | QUEUE | Nurture (retry in 30 days, opt-out) | built | Re-engagement sent, replied, opted out in the period; contacts in their 30-day cooldown now. Activity = sent. No screen yet: the window says so. | — |
| S5 | AGENT 03 | Classify unit (rent vs sale, price check) | not tracked | Needs a units inventory in Nexus (type, price). | — |
| S6 | INVENTORY | Rent units (Ejari-ready, cheque terms) | not tracked | Needs rent listings with Ejari readiness and cheque terms. | — |
| S7 | INVENTORY | Sale units (title deed, owner docs) | not tracked | Needs sale listings with document status. | — |
| S8 | GATE | Compliance (Form A + Trakheesi permit) | not tracked | Needs, per listing, the Form A and the Trakheesi permit number and expiry. | — |
| S9 | AGENT 04 | Listing & ads (copy, photos, budget split) | not tracked | Needs listings and ad spend per channel. | — |
| S10 | LIVE | Portals + social (Bayut · Dubizzle · PF · Meta · TikTok) | not tracked | Needs listing status per portal. Leads that arrive from these appear in D1. | — |

**Demand — lead to closed deal**

| # | Tag | Step (boss's subtitle) | Coverage | Evidence / what is missing | Link |
|---|---|---|---|---|---|
| D1 | INBOUND | New lead (portal, WhatsApp, ad form) | built | New leads (§7.3) in the period, by channel, and by lead source where one was recorded. Activity = new leads. | Inbox |
| D2 | AGENT 05 | AI qualifier (budget, timeline, finance) | partly | Leads scored; hot (high or urgent); sales pitches filtered out. Missing: budget, timeline and finance are not captured. | Customers |
| D3 | QUEUE | Cold lead (drip follow-up) | built | The same re-engagement queue as S4 (shown once, the window says "same queue as Nurture"). Activity = sent. | — |
| D4 | AGENT 06 | Unit matcher (sends 3 best-fit units) | not tracked | Needs the units inventory (S5–S7). | — |
| D5 | HUMAN | Viewing (AI books slot, agent attends) | built | Viewings in the period: booked, held (completed), no-show, cancelled. Activity = booked. | Appointments |
| D6 | HUMAN | Offer & negotiation (AI drafts, you approve) | not tracked | Needs offers recorded per lead. | — |
| D7 | CLOSE | Rent deal (tenancy contract, Ejari) | not tracked | Needs deal records with the Ejari number. | — |
| D8 | CLOSE | Sale deal (KYC/AML, Form F, DLD) | not tracked | Needs deal records with KYC, Form F and the DLD transfer. | — |
| D9 | AGENT 07 | CRM & commission (logs deal, tracks team) | partly | Follow-ups created and done in the period; open now; overdue now. Missing: commission. | Workspace |
| D10 | OUTPUT | Daily AI report (pipeline summary to you) | not tracked | Nothing is sent daily; this page is the live version. Needs a daily summary sent to the owner. | — |

Under D7 and D8, one shared note: "Won (labelled) in this period: N — rent or
sale isn't recorded" (§7.3).

Count today: 4 built (S4, D1, D3, D5), 5 partly (S1, S2, S3, D2, D9), 11 not
tracked.

### 4.3 Drawing it

- Desktop: two lanes as on the boss's canvas — cards in a row with arrows,
  branches kept ("not now" → Nurture; rent / sale split; "cold" → Cold lead).
  The lanes scroll sideways inside their box when the window is narrow.
- Phone: each lane becomes a vertical list with downward arrows; branches as
  indented pairs.
- Each card: the tag, the name, a status chip, and up to three figures.
- Opening a card (click, tap, Enter) opens a CardWindow: the full evidence,
  what Nexus does and does not do for the step, and the link (or "no screen
  yet").
- Motion (only with `prefers-reduced-motion: no-preference`): connectors draw
  in lane by lane; a soft pulse travels along the paths between Working cards.

## 5. Tiles and charts

All for the chosen period, in the business's own days (§7.2). Today is
included up to now and marked as in progress.

**Six NumberTiles:** New leads · Median first reply · Hot leads · Viewings
held · Follow-ups overdue now · Won (labelled).

**Five ChartCards:**

1. **Leads coming in.** AreaChart of new leads per bucket. A bucket with no
   new leads is a measured 0 (counted from raw rows). Below it, a `kit-hbar`
   per channel with its count.
2. **How fast SFS answers.** BarChart of the median first-reply time per
   bucket (§7.3). A bucket where no new lead was answered draws an **empty
   slot labelled "no replies"**, never a zero. Beneath: first reply by AI /
   by a person / not answered yet (counts).
3. **From lead to won.** A funnel over the same people: new leads → scored →
   hot → viewing booked → viewing held → won (labelled). Each step shows its
   count and its share of the step before — as "3 of 7" when the step before
   is under 20 people, as a percentage from 20 up.
4. **Viewings.** BarChart of viewings per bucket (by viewing date, cancelled
   excluded), the held part shaded; no-shows and cancellations in the hover
   label.
5. **Lead quality.** BarChart of leads scored per bucket (pitches excluded),
   the hot part shaded; a note counts the pitches filtered out.

Buckets: days for 7 and 30; **weeks** (Monday-start, business-local) for 90.
The bucket holding today is drawn hatched (`partial`).

## 6. Dubai compliance checklist

A kit table: the compliance items the workflow names — Form A, Trakheesi
permit, Ejari, Form F, KYC/AML, DLD transfer — each marked "Kept outside
Nexus" with the step it belongs to and what tracking it would need. Beside
them, what Nexus does record about consent: re-engagement opt-outs, email
opt-outs, contacts marked "not a customer", with their counts.

## 7. Data and server

### 7.1 Endpoint

`GET /api/organizations/:slug/workflow-audit?days=7|30|90` — read-only.
Behind `requireTenantScope`. Any other `days` value → 400. The handler
resolves the business by slug and calls the database read.

### 7.2 Days

Periods and buckets are the business's own days, from
`organizations.timezone` (Asia/Dubai for SFS), computed in SQL with
`at time zone`. The period runs from the start of the first day to now.

### 7.3 Definitions (one place, `packages/db/src/workflow-audit.ts`)

All queries run inside the business's tenant scope (`withTenant`), so the
database's row-level security keeps other businesses out, as well as every
query filtering by the business.

- **New lead:** a conversation of the business started in the period, whose
  contact is not marked "not a customer" and which is not scored as a sales
  pitch (`lead_assessments.category = 'inbound_pitch'`). Pitches are counted
  separately.
- **First reply** of a new lead: the first message with `sender_type` in
  (`ai_agent`, `human_agent`) after the conversation's first `contact`
  message; its time minus that message's time; and who sent it (AI or
  person). `system` messages do not count. Median per bucket over new leads
  that were answered. (`conversation_metrics.first_response_ms` is not used:
  it times the automatic pipeline per inbound message and is capped at 24
  hours, so a person's later reply never shows.)
- **Scored / hot:** `lead_assessments` rows created in the period, pitches
  excluded; hot = priority `high` or `urgent`. In the funnel: a new lead's
  contact with an assessment on or after their first chat.
- **Viewings:** `bookings` by `starts_at` in the period (up to now); booked =
  not cancelled; held = `completed`; no-show; cancelled.
- **Won (labelled):** `lead_labels` with outcome `won` whose label was set or
  updated in the period. In the funnel: on a new lead's contact.
- **Re-engagement:** `reengagement_attempts` sent / replied / opted out in the
  period; in cooldown now = `cooldown_until > now()`.
- **Outreach:** broadcast messages to the business's recipients in the period
  — sent / delivered / failed.
- **Calls:** `call_logs` in the period by outcome.
- **Follow-ups:** `tasks` created and completed in the period; open now;
  overdue now (the database clock, as the board does).
- **Contacts:** total; added in the period; with `lead_source` recorded;
  opted out of re-engagement; marked not a customer.

### 7.4 Response

```ts
type WorkflowAudit = {
  business: { slug: string; name: string; timezone: string };
  period: { days: 7 | 30 | 90; from: string; today: string; bucket: "day" | "week" };
  evidence: {
    contacts: { total: number; added: number; withSource: number; optedOut: number; notACustomer: number };
    outreach: { sent: number; delivered: number; failed: number };
    calls: { answered: number; noAnswer: number; voicemail: number; busy: number; failed: number };
    reengagement: { sent: number; replied: number; optedOut: number; inCooldown: number };
    leads: { total: number; pitches: number; byChannel: Record<string, number>; bySource: { source: string; count: number }[] };
    qualifier: { scored: number; hot: number };
    replies: { medianMs: number | null; byAi: number; byPerson: number; unanswered: number };
    viewings: { booked: number; held: number; noShow: number; cancelled: number };
    won: number;
    followUps: { created: number; done: number; openNow: number; overdueNow: number };
  };
  series: {
    leads: { bucket: string; count: number }[];
    replyMedian: { bucket: string; medianMs: number | null }[];
    quality: { bucket: string; scored: number; hot: number }[];
    viewings: { bucket: string; booked: number; held: number; noShow: number; cancelled: number }[];
  };
  funnel: { leads: number; scored: number; hot: number; booked: number; held: number; won: number };
};
```

`bySource` lists the six most common sources.

### 7.5 The workflow definition

`packages/shared/src/workflows/` holds:

- `real-estate.ts` — the 20 steps of §4.2 (id, lane, tag, name, subtitle,
  coverage, the evidence it reads, what is missing, link, and the branches).
- `status.ts` — the pure `stepStatus(step, evidence)` and `verdict(...)`.
- `index.ts` — a registry `workflowFor(slug)`: `sfs-international` → the
  real-estate workflow; anything else → null.

The registry decides the staff sidebar item, the Business HQ link, and the
page's business switcher.

## 8. Honesty rules (enforced by tests)

- No literal series and no figure written into the page; the console's "no
  invented numbers" guard tests are extended to this page.
- A missing value is never drawn as 0: no reply → an empty "no replies" slot;
  measured zeros show as "0".
- The funnel follows one cohort; under 20 it shows "x of y".
- Not-tracked steps show no figures.
- Colleagues' individual figures are never listed.

## 9. Errors and empty states

- Load failed: "The audit could not be loaded." where the page would be —
  never an empty workflow.
- A business with no workflow: "No workflow is set up for this business yet."
- No activity: built steps show Idle; charts show the kit's "Not enough days
  yet"; tiles show measured zeros.
- While loading: a "Loading…" line, not an empty chart.

## 10. Kit addition

`BarChart` accepts a bar whose `value` is `null`: an empty column with a
dashed outline, its hover/read-aloud label saying the bar's `emptyLabel`
("no replies"). Nothing is drawn at zero height for it.

## 11. Testing

Written first, as in part 2a:

- **Pure:** `stepStatus` and `verdict` for every coverage × activity case;
  the funnel's "x of y" / percentage switch at 20; week bucketing; the
  business-local day boundaries; BarChart's null bars.
- **Database:** the audit queries on a throwaway Postgres seeded with SFS and
  a second business — each count; the Dubai day edges; pitches and "not a
  customer" left out; first reply by AI and by a person; the second business
  never counted.
- **API:** staff of another business get 403; a `days` outside 7/30/90 gets
  400; `getWorkflowAudit` in `lib/api.ts`; `/deck/workflow` added to "staff
  see only their business" and "the same door twice".
- **Page:** render tests of the workflow (status tones, evidence, not-tracked
  copy, the shared won note), the funnel, the empty and error states; the
  "no invented numbers" guards.
- **Browser:** stand-in SFS data at desktop, Warm Night and 375 px; keyboard
  (Enter opens a step, Tab stays in, Escape returns); touch.

## 12. Out of scope

Tracking the untracked steps (units, permits, offers, deals, commission),
manual statuses or typed-in figures, per-person views, workflows for other
businesses, sending a daily report, exports.

## 13. Delivery

Built on branch `sfs-audit` in its own worktree (`C:\CLAUDE CODE\nexus-sfs-audit`).
A fresh final review, then the owner's review. Deployed only on the owner's
"Deploy it". No database change: a plain merge, push and `deploy.sh`.
