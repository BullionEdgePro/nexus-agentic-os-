# A compact SFS board, and "My board" on the staff home screen — design

Date: 25 Nov 2026 · Business: SFS International Real Estate · Approach chosen by the owner: **A**

## 1. Why

The owner wants SFS staff to find their units and deals on the Workflow Board fast and
reliably. Today (seen live on 25 Nov) the page is long and noisy:

- a large title, a four-line explanation and the install banner fill the first screen;
- the six unit steps sit in a strip that scrolls sideways, so some are off-screen; empty steps
  take full-size boxes saying "nothing here";
- "Hot leads not on the board" lists up to 20 rows, each with a button, and pushes the deal
  steps far down; it mixes in the business itself ("SFS INTERNATIONAL REAL ESTATE LLC"), sister
  businesses ("Juris Prime Legal…"), and names that are only a number;
- the "Runs by itself" counts take a full block in each half though staff never act on them.

Staff can already open the board (`/deck/workflow`, their own business), but their home screen
(My Day, `apps/web/app/my-day.tsx`) does not show it.

**Success:** a staff member opening the board sees every step without scrolling sideways, sees
their own cards at once, and on their home screen sees "what of mine is on the board and what
needs me" without opening it.

**Anti-goals:** nothing staff can do today disappears (add unit/lead, drag, open a card, Portal
settings, Waiting longest, Closed in 30 days); no colleague's deal becomes visible to staff (the
"+N with colleagues" rule stays); no new database tables in this piece.

## 2. Approaches (owner picked A)

- **A. Tighten the board and add a "My board" card to My Day** — one board, one set of rules,
  and a short summary where staff already start their day. *Chosen.*
- B. A separate, simpler staff board — two boards to keep in step, the admin board stays crowded.
- C. Only the My Day card — quickest, but the board itself stays crowded.

## 3. The board page (`/deck/workflow`, Board tab)

1. **Header:** one line — "SFS International · Board" with Refresh and Portal settings on the
   same row. The explanation paragraph moves behind an ⓘ button (still readable on click). The
   business pills show only for admins (as today).
   *As built (25 Nov 2026):* the title line is the business name and the ⓘ; Refresh, Portal
   settings and "Only mine" sit on the board's own toolbar row, under the Live picture / Board
   tabs, because the same board is drawn inside Business HQ's Workflow tab, which has its own title.
2. **Top strip:** "Closed in the last 30 days" and "Waiting longest" side by side as one slim row
   (smaller figures), not two tall boxes.
3. **Steps wrap, never scroll sideways:** each lane's steps lay out in a grid that wraps to the
   screen width (about 3 per row on a laptop, 1–2 on a phone).
4. **Empty steps shrink:** a step with no cards (and no "+N with colleagues") shows as a small
   chip — name and 0 — in a single "Empty steps" row under the lane, still a drop target while
   dragging (it opens to full size when a card is dragged over the lane).
   *As built (final review, 25 Nov 2026):* the row is the last row inside the lane's own board
   box (the drag only lands inside the dragged card's board), and it opens while a card **of that
   lane** is dragged; the other lane's row stays folded. While a card is held near the top or
   bottom of the screen the page scrolls by itself, so a step below the screen can still be
   reached by finger. A drop goes only to a step the pointer is seen over — never one hidden under
   the phone's tab bar or the dock, nor one past the window's edge.
5. **Steps with cards come first**, in workflow order, so the cards are the first thing seen.
6. **"Runs by itself"** becomes one quiet line per lane: "Runs by itself · 30 days: Owner
   database 234 · Data filter 103 · WhatsApp + AI call 152 · Nurture 0".
7. **Hot leads:** the 5 newest are shown, then "Show all (N)". Left out of the list (server side,
   same query): a contact whose number is one of this business's own WhatsApp lines or a staff
   member's phone; a contact whose name matches the business's own name; a contact whose
   number is the WhatsApp line of another business in Nexus. *(My call — see §6.)*
   *As built (25 Nov 2026):* a contact whose number is one of **this business's own** staff
   WhatsApp lines, or whose name starts with the name of a business on Nexus (our own, or a
   sister firm). Another business's staff numbers are private to it, so a sister firm is caught by
   its name, not its numbers. A staff number saved as "050 480 5436" or "00971 50 480 5436" is the
   same line as its WhatsApp id when the last nine digits agree; a WhatsApp username id is never
   read as a number.
8. **"Mine" first and marked:** for staff, cards where they are the agent carry a small "Mine"
   tag, and within each step their cards sort first. An optional "Only mine" toggle at the top
   filters the board to their cards (units and deals). Admins keep the full board; the toggle is
   shown to staff only.
9. **Card faces stay** as they are (reference, community, price, days in step, portal state).

## 4. "My board" on My Day (staff only, and only when their business has a board)

A card in My Day's main column, under the existing counters:

```
My board                                         Open board →
Units   Rent 2 · Sale 1 · Listing & ads 1 · Live on Bayut 1
Deals   Viewing 3 · Offer & negotiation 1
Needs me
  • Marina Gate 2BR — permit missing
  • Ahmed K. — viewing today 4:00 pm
```

- Counts are of **their** cards (agent = them) by step; a step with 0 is left out; "Live on
  Bayut" counts their units whose Bayut row is live (the board's own `isPublished`).
- **Needs me** (at most 5, most urgent first): a card of theirs that cannot move on because
  something is missing (`moveProblem` / the portal readiness line), a permit that expires within
  14 days, a portal that refused a listing, a viewing today. Each line opens that card on the
  board (`/deck/workflow?card=<id>`).
  *As built (final review, 25 Nov 2026):* most urgent first means a viewing today (earliest
  first), a permit that has expired (oldest first), a portal that refused a listing, a permit
  expiring within 14 days (soonest first), then a card that cannot move on or is wanted on a
  portal but not ready — in its card's own words, "Off the portals: 3 photos". One line per card,
  its most urgent; past five, "+N more on the board". "Live on Bayut" is the Bayut part of
  `isPublished`: wanted, ready and live there.
- No cards of theirs: one line — "Nothing of yours on the board" — and the Open board link.
- Data: the existing `getWorkflowBoard(slug)` (already scoped to what staff may see); no new API.
  If it fails, the card says "Could not load your board" and the rest of My Day is unaffected.

## 5. Not in this piece

A "not a lead" button to hide a hot lead for good (needs a new table); changes to card detail,
Portal settings, or the Live picture tab; other businesses' workflows (they get the same compact
board automatically, since it is one component).

## 6. Calls I made (owner can change any)

- Hot leads show 5 then "Show all"; the three exclusion rules in §3.7.
- Empty steps collapse to chips but expand while dragging so drops still work.
- "Only mine" is a toggle, off by default; "Mine" cards always sort first.
- "Needs me" uses: missing item to move on, permit expiring within 14 days, portal refused,
  viewing today — at most 5 lines.
- Opening a card from My Day goes through `?card=<id>` on the board page (the page opens that
  card's detail on load).
- *Final review, 25 Nov 2026:* a link from My board (or a pocket-listing alert) opens the Board
  even when this browser last showed the Live picture, but does not change the tab the browser
  remembers — only a pick by hand does. Once the card is open, `?card=` leaves the address and
  `?view=board` stays, so a reload stays on the Board and never reopens the card.

## 7. Testing

Web tests for: the header and ⓘ; lanes render as a wrapping grid; empty steps as chips and
expand while dragging; steps with cards first; the hot-leads cap and "Show all"; "Mine" tag and
sort; the "Only mine" filter; My Board counts, Needs me rules, empty and error states; `?card=`
opens the card. API test for the hot-leads exclusions. Existing board, portal and My Day tests
still pass. A look at the page live-like (mock API) at laptop and phone width before deploy.

## 8. Rollout

Web + API change, no migration. Deploy only on the owner's "Deploy it".
