# Staff-first compact Nexus — piece 2: My queue (the inbox) shows the chats first

Date: 26 Nov 2026. Owner: "Yes, piece 2" — the second piece of "do ui and ux more good compact
and sleek … specially to use my staff easier" (piece 1, live at e1654e4:
2026-11-26-staff-first-compact-design.md, whose §5 named this piece).

## 1. What a staff member meets today (preview as SFS staff, 26 Nov 2026)

- **Phone (375px):** the first conversation starts 551px down. Above it: the pipeline stage tabs,
  the business name, ten folder pills in five rows (Open, Closed, Awaiting reply, Unread, All, My
  chats, SLA breached, Follow-up due, Snoozed, Human-held), the "My queue" header, and four queue
  chips in two rows. Two conversations fit above the tab bar.
- **Laptop at 1024px (the 760–1100px layout):** the folder panel sits above the list and may take
  42% of the height; three conversations fit.
- **Three overlapping filters:** stage tabs, folders, and My queue's chips (Waiting, Snoozed,
  Follow-ups, All mine — inbox page.tsx `QUEUE_CHIPS`), which already answer what staff ask all
  day.
- **Each of a staff member's own rows** carries a line with their own name ("Aisha Khan"),
  which tells them nothing.

## 2. Goals, anti-goals

Goals:
1. **Filters fold away for staff.** The sidebar (business, folders, View filters) starts folded
   for a staff member and is opened by a "Filters" button in the list header (`aria-expanded`).
   Admins start with it open, exactly as today. The choice is remembered per browser
   (`nexus.inbox.filters` = "open" | "closed").
2. **Nothing is hidden by surprise:** the Filters button shows how many filters are on beyond the
   staff's own queue view — a folder outside My queue's chips, a tag, a channel, a date range, a
   stage — e.g. "Filters · 2".
3. **Phone:** My queue's chips sit on one row (the row scrolls sideways inside itself if a long
   count needs it; the page never does).
4. **Rows:** on a staff member's own conversations the "assigned to" line is left out; it stays for
   unassigned conversations ("Unassigned · WhatsApp") and for anyone else's.

Anti-goals: no folder, filter or action disappears; the admin's inbox looks and works as today;
no change to what any button does; no sideways page scroll at 375, 1024, 1440px.

## 3. Approaches (owner's standing rule: take Claude's recommendation)
- **A. Fold the sidebar behind "Filters" for staff; one-row chips; drop the self-name line.**
  *(Chosen.)* Biggest gain, nothing moves for admins.
- B. Replace the folders with a dropdown for everyone — changes the admin's daily tool.
- C. Redesign the whole inbox including the conversation header — the largest and riskiest
  change, on the most-used screen.

## 4. The design
- Pure rules in `apps/web/lib/inbox-layout.ts` (testable without a DOM):
  - `filtersStartOpen(isStaff, stored)`: a stored "open"/"closed" wins; otherwise open for an
    admin, folded for staff.
  - `activeFilterCount({ folder, tag, channel, dateRange, stage, owner }, queueKeys)`: 1 for a
    folder outside `queueKeys` (staff) — 0 for any folder when `queueKeys` is null (admin) — plus 1
    each for a tag, a channel, a date range other than "any", a stage, an owner.
  - `showsAssignee(conversation, myEmployeeId)`: false only when the viewer is staff and the
    conversation is assigned to them.
- Inbox page: a `filtersOpen` state started by `filtersStartOpen` once the role is known; the
  root gets `side-folded` while folded; a "Filters" button (with the count when above 0) in the
  list header toggles it and stores the choice. CSS: `.ibx.side-folded .ibx-side { display: none; }`
  and, at ≥1100px, the grid's side column is 0 wide when folded.
- Phone: `.ibx-chips` `flex-wrap: nowrap; overflow-x: auto` under 760px.

## 5. Calls I made (owner can change any)
- Only staff start folded; admins keep today's open sidebar.
- The pipeline stage bar stays where it is (it also carries the Live / Reconnecting sign).
- The conversation header (two rows of buttons) is left for a later piece.

## 6. Testing
Web tests: the three pure rules; the page wires them (source pins: the Filters button with
`aria-expanded`, the `side-folded` class, the stored key, the assignee line behind
`showsAssignee`); the CSS rules. The whole web suite and typecheck. A look in the preview as SFS
staff at 1024px and 375px, and as an admin (unchanged).

## 7. Rollout
Web only, no migration. Deploy only on the owner's "Deploy it".
