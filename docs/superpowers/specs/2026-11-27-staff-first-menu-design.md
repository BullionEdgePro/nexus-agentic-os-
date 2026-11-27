# Staff-first compact Nexus — piece 6: the staff menu and the phone tab bar

Date: 27 Nov 2026. Owner: "Yes, last piece" — §5 item 5 of 2026-11-26-staff-first-compact-design.md
("The menu for staff — 17 doors today; group or trim, and choose the phone tab bar's four").
Owner's standing preference: take the recommended option and proceed.

## What staff meet today (preview, SFS staff, 27 Nov 2026)
- **Laptop (1366×768)**: the rail is 1289px tall in a 744px column. Ten of seventeen doors are in
  view; Knowledge, Answer rules, Forecast, Workflow, Connections, My settings, Notifications and
  Sign out are below the fold. Rows are 48px, section headings 35px.
- **Phone Menu**: a flat list of 17 text links (~1006px), in NAV order — not the rail's sections or
  order — with no icons; the tab bar and the Ask button cover the sheet's bottom.
- **Phone tab bar**: Queue · Team · Follow-ups · Me, where "Me" opens My Day, not a profile.

## Goals
- The whole staff menu fits a 768px-high laptop without scrolling.
- The phone Menu reads like the rail: same sections, same order, icons, nothing covered.
- Every tab says where it goes.

## Non-goals / anti-goals
- No door removed, renamed or hidden from anyone who has it today; no change to who sees what.
- Admins keep every section open (their menu is theirs; this piece is for staff).

## Approaches
- **A. Tighter rows for all + a "More" fold for staff's three less-daily sections.** *(Chosen: the
  daily doors stay one tap away; nothing is lost; fits 768px.)*
- B. Tighter rows only — still ~1000px for staff; does not fit.
- C. Trim staff doors (drop Workflow, Forecast…) — removes things people may use.

## The design
1. **Rail rows** (everyone): link padding 9px→5px, icon tile 30→28px (rows ~38px); section
   headings 14/5px padding → 9/3px (~26px).
2. **Staff "More"** — `STAFF_MORE_GROUPS = ["AI agent", "Insights", "You"]` in `lib/nav.tsx`;
   pure `railSections(items, role)` → `{ main, more }` (operator: `more` empty). After the main
   sections the rail shows a `More` button (`aria-expanded`, chevron); its sections render under
   it when open. It starts open when the current page is one of its doors; otherwise it follows the
   browser's last choice (`localStorage` "nexus.rail.more", read and written inside try/catch),
   default closed.
3. **Phone Menu** — groups its items with `railSections` (main then more, all shown), a heading
   per section, each door with its glass-tile icon, two to a row; the sheet sits above the tab bar
   (z-index) and keeps its bottom padding clear of it.
4. **Phone tab bar** — "Me" → "Today", with a home icon (it opens My Day / the Overview).

## Calls I made (owner can change any)
- "More" holds AI agent, Insights and You; Home, Work and People stay open.
- "Today" for the home tab, for staff and admins alike.
- Admins get the tighter rows, not the fold.

## Testing
Render test for `railSections` (staff split, operator unsplit, empty sections dropped) and for the
"starts open" rule; source pins for the More button, its try/catch storage and the phone menu's
headings/icons; CSS pins for row sizes, the two-column phone grid and the sheet's z-index above the
tab bar; the existing "phone reaches every door" and "glass tiles" tests stay green. Preview as
staff at 1366×768 (rail fits) and 375px, and as admin.

## Rollout
Web only, no migration. Deploy only on the owner's "Deploy it".
