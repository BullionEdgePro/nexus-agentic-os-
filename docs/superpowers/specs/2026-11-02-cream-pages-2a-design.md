# Cream pages, part 2a — the shared pieces and the six video pages

Date: 2026-11-02
Status: approved in conversation (kit, front page, board, other pages + testing — all "Looks right")
Part 2a of the video-inspired redesign. Part 1 (theme, one sidebar, motion and
sound kit) is live: `2026-11-01-cream-foundation-design.md`. Part 2b moves the
other 17 dashboard pages and the inbox onto the same pieces; part 3 is the
storefront. Each gets its own spec, plan and deploy.

## What the owner asked for

> "audit this video in detail then I want to apply all the animation, graphics,
> motion graphics, design, themes, sound effect, motion effect … in nexus … the
> frontstore and all dashboard … make it full"
> (YouTube Short 8N1ae8hMEcs, a sales CRM demo)

Decisions the owner made for part 2:

1. **Two deploys.** 2a: one set of shared pieces plus the six pages that match the
   video's screens. 2b: every other page and the inbox, on the same pieces.
2. **Shared pieces**, built once (not each page restyled in place, not a UI
   library). The board's drag is written on pointer events, not the browser's
   built-in drag.
3. **The front page's coloured cards show the customers waiting longest**,
   coloured by how long they have waited.

## The video's screens and their Nexus pages

| Video | Nexus (2a) |
|---|---|
| Overview: number chips, revenue chart with a hover label, coloured "hot deal" cards | Admin front page `/` ("Operations overview", `app/deck-console.tsx`) |
| Deal pipeline: coloured cards in columns, dragged | Workspace board `/deck/board` (overdue / today / later / done) |
| A card grows into a centred window | Opening a board card |
| Customer profile with coloured interaction history | Customers `/deck/customers` |
| Cash flow: area chart, ageing bars | Forecast `/deck/forecast`, Agent quality `/deck/quality` |
| — (status at a glance) | Business HQ `/deck/hq` overview |
| Invoice slides in from the right | The customer profile panel |

## Rules that hold everywhere

- **No invented data.** Every figure is one Nexus already has. Where a page
  refuses to show something (Forecast's "not until the method has been marked
  against this business's own past"), the refusal stays, in the new look.
- **No new npm dependency.** Charts are SVG drawn by our own small maths module.
- Colours only from the Cream / Warm Night tokens on `.deck-root` (part 1),
  including the status pairs `--st-mustard/--on-mustard`, `--st-forest/--on-forest`,
  `--st-terra/--on-terra`, `--st-ink/--on-ink`. No pure black.
- Motion only inside `@media (prefers-reduced-motion: no-preference)`; part 1's
  helpers (`data-countup`, `.nx-draw`, `.nx-grow`, stagger) are reused.
- Sounds through part 1's `play()` and its mute switch: `pop` when a card opens
  into a window, `whoosh` when the profile panel slides in, `chime` on a
  successful drop.
- Every control works with a keyboard and has a name a screen reader reads.

## 1. The kit — `apps/web/app/kit/`

One stylesheet, `kit.css`, and one component per piece:

1. **NumberTile** — icon in a circle, label, big figure with `data-countup`
   (tabular numbers), a note chip under it (today's hint text: "last 7 days",
   "since midnight"), an optional sparkline drawn with `.nx-draw` only when real
   points exist.
2. **StatusCard** — a card in one tone (`mustard | forest | terra | ink | paper`)
   with title, subtitle, figure and footer (initials). Lifts on hover. When it
   has an action it is a button or link; when it opens into a window it carries a
   `view-transition-name` for that.
3. **ChartCard** — header (title, big figure, optional period pills) over one of
   `AreaChart`, `LineChart`, `BarChart` (bars may be stacked in two tones, or a
   range band with a mid mark). The line draws in, bars grow. A hover label (an
   ink pill) follows the pointer or finger to the nearest point; the chart is
   focusable and ←/→ step through points, announcing "<label>: <value>".
4. **BoardColumn / BoardCard** — a coloured column head with its name and a count
   pill; cards are StatusCards in the column's tone. Dragging (pointer events,
   mouse and touch): the card lifts and tilts 3°, the others slide aside
   (measure-and-animate), the column under the pointer lights up; Escape or a
   cancelled pointer puts it back.
5. **CardWindow** — a card grows into a centred window over a blurred page (a
   View Transition from the card's rect where supported; otherwise a scale from
   the card's position). Closes on ✕, Escape and a click outside; focus moves in
   and returns to the card on close; plays `pop`.
6. **SlidePanel** — slides in from the right over a frosted page; same closing
   and focus rules; plays `whoosh`. Full screen on a phone.

Pure logic lives in `apps/web/lib/kit/` with no DOM: `chart-math.ts` (linear
scales, nice ticks, a smooth path through points, the nearest point to an x),
`drag.ts` (which column a point is over, the order after a drop), `place.ts`
(where a window opens from a card's rect), `wait-band.ts` (wait time → tone).

## 2. The admin front page

- Title in part 1's big two-line style.
- The four quick links (Conversations, Needs attention, Broadcast, Team & inbox
  rules) become ink pills with their icons.
- **Number row:** six NumberTiles in two rows of three — Active conversations,
  AI resolution, Messages today, Avg first response, Governance holds, Tokens
  used — each counting up to its real value with today's note under it. No
  invented change percentages, no sparkline without real points.
- **Customers waiting:** up to six StatusCards, longest wait first, across every
  business. Tone by wait (`wait-band.ts`):

  | Waited | Tone |
  |---|---|
  | under 30 minutes | forest |
  | 30 minutes – 2 hours | mustard |
  | 2 – 24 hours | terra |
  | over a day | ink |

  Each card: the customer's name (or number), the business, "waited 3 h 12 m",
  and the staff member's initials (full name in the label). A click opens
  `/inbox?conversation=<id>`. When more are waiting, a "+N more waiting" link
  goes to `/deck/activity`. When nobody is waiting, one paper card says so.
- **Conversations** becomes a ChartCard with an AreaChart and the hover label
  (day, count). **Intent mix** bars grow. **Live feed** is a kit list card.
  **Switchboard router** and **Governance** keep their content in paper cards.

### The one server addition

`GET /api/activity/staff-work` (admin only, unchanged otherwise) adds to
`attention`:

```
oldestWaiting: Array<{ conversationId, contactName, employeeName, businessSlug, businessName, since }>
waitingTotal: number
```

the six longest waits of ANY length (the existing `waitingLong` is only over two
hours), oldest first, drawn from the same `waiting` list (inbound last, not a
pitch, not snoozed, a customer). `packages/db/src/staff-work.ts` and its type;
`apps/web/lib/api.ts` `StaffWorkAttention`.

## 3. The Workspace board

- Column tones: **Overdue** terra, **Today** mustard, **Later** forest, **Done**
  ink. Column heads as in §1.4.
- Cards: the follow-up's title, the business, who has it ("nobody yet"), and when
  it is due (today's `whenLabel`), in the column's tone.
- **Drag** with mouse or finger (§1.4). A drop makes exactly the change today's
  drop makes (`columns.ts`: to Today = this afternoon, to Later = tomorrow, to
  Done = complete, crediting who dragged; nothing out of Done), plays `chime`,
  and on failure the card springs back with the error in the board's error line.
- **Open a card** (tap, click, Enter): a CardWindow with the title, notes, the
  customer, the due time, who has it, and actions **Mark done**, **Open chat**
  (when the follow-up has a conversation), and **Move to Overdue / Today /
  Later** — the keyboard's and the no-drag way to move it.
- **Automations** stays under the board in paper kit cards.

## 4. Customers, Forecast, Agent quality, Business HQ

- **Customers:** the list becomes cards (initials badge, name, number, the
  "remembered" / "opted out" tags, last message). Opening one slides in a
  SlidePanel: initials or photo, name, number, **Open chat**; "What this platform
  remembers" as label/value rows with Forget kept; conversations as small
  StatusCards toned by state (open forest, pending mustard, closed ink). On a
  phone the panel is full screen.
- **Forecast:** each metric is a ChartCard; predictions draw as a range band with
  a mid mark; the hover label gives the day, the predicted range and the "same
  weekday last week" baseline. Refusals ("not yet marked against this business's
  own past") are calm paper note cards, never an empty chart. The accuracy table
  is a kit table.
- **Agent quality:** the summary figures become NumberTiles; **Daily** becomes a
  stacked BarChart (escalated part terra) with the hover label; the "what reaches
  a person most" table is a kit table; the Ask box keeps its behaviour in kit
  styling.
- **Business HQ** overview: each business card gets a top edge toned by its
  health (forest healthy, mustard watch, terra needs you — today's
  `scoreTone`), and the score ring draws in. Issues listed as now.

## 5. Phones

Number tiles 2 per row; status cards one column; the board scrolls sideways by
column with a snap, drag works by touch; CardWindow and SlidePanel full screen;
chart hover label follows the finger.

## 6. Testing (written first)

- Pure: `chart-math` (scale, ticks, smooth path endpoints, nearest point),
  `drag` (column under a point, order after drop, no drop out of Done),
  `place`, `wait-band` (each band edge).
- Kit components rendered with `react-dom/server` and checked for what they show:
  the figure and its `data-countup`, the tone class, the accessible names, the
  chart's SVG path and its focusable points, the window's dialog role and label.
- Pages: each uses the kit pieces; the front page's waiting cards come from
  `oldestWaiting` and link to the inbox; the board's window offers Move to.
- API: `oldestWaiting` is oldest first, includes waits under two hours, excludes
  pitches, has at most six, and `waitingTotal` counts them all.
- Browser check with sample data: all six pages at desktop width, in Warm Night
  and at 375 px; drag by mouse and by touch; a window and a panel opened and
  closed by keyboard.
- One fresh reviewer for the whole branch before the owner's review.

## 7. Deploy

No database change. Branch `cream-pages-2a` from `main`; the owner reviews, then
"Deploy it": push `main`, `scripts/deploy.sh` on the VPS, wait for the PASS line.
