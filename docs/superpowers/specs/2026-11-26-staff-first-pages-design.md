# Staff-first compact Nexus — piece 5: Customers, My clients, Knowledge, Answer rules

Date: 26 Nov 2026. Owner: "Yes, next piece" — §5 item 4 of 2026-11-26-staff-first-compact-design.md
("Customers, My clients, Knowledge and Answer rules — denser cards and folded forms"). Owner's
standing preference: take the recommended option at choice points and proceed.

## What staff meet today (preview, signed in as SFS staff, 26 Nov 2026)
- **Four pages do not work for staff at all.** Customers, Knowledge, Answer rules and Forecast start
  on Zipicka (`useState<BusinessSlug>("zipicka")` / `TENANTS[0].slug`) and never change for an
  employee; `requireTenantScope` answers 403 "You don't have access to that business." for any slug
  but the employee's own. (The preview's mock ignores the slug, so the pages looked fine there; the
  request URLs show `/organizations/zipicka/...`.)
- **My clients**: a long always-open explanation; Your link and Your WhatsApp panels sit above the
  book; on a phone the client table is 471px wide in a 331px column — half of every row is off
  screen.
- **Customers**: each card is ~115px tall on a phone — three customers per screen.
- **Knowledge**: the "Teach it something" form sits above what the agent knows.
- **Answer rules**: three big counter boxes; "Write one yourself" always open below the list;
  the counts would show the last load's numbers under a failed load.

## Goals
- Every page in the staff menu opens on the staff member's own business.
- Content first: the list a person came for is the first thing under the header; forms wait behind
  a "+ …" button (the AddFold already used by Follow-ups and Appointments).
- Denser, never cramped: more rows per phone screen, nothing scrolls sideways.

## Non-goals / anti-goals
- No change to what any page can do, who may do it, or the API.
- Nothing deleted: explanations move behind ⓘ, forms behind a button.
- No new list component for all four (YAGNI).

## Approaches
- **A. Reuse the live kit pieces page by page, plus one shared "which business" hook.** *(Chosen:
  the pieces are proven, each page keeps its own logic, and the staff bug is fixed in one place.)*
- B. One new list/card component for all four pages — a rewrite of four lists for little gain.
- C. CSS only — denser, but leaves the staff 403 and the open forms.

## The design
1. **`usePageBusiness(fallback: BusinessSlug)`** in `lib/business-tabs.tsx` →
   `[business: BusinessSlug | null, setBusiness]`. `null` until `useVisibleBusinesses().known`; then
   an employee's own slug (`mySlug`), an operator's `fallback` (or what they chose). Customers,
   Knowledge, Answer rules (and its phrases section) and Forecast use it and do not load until it
   is set (the outline shows meanwhile).
2. **Customers**: tighter cards — smaller padding and initials, name and number on one line when
   there is room, the meta chips one row; ~6 customers per phone screen. Import stays where it is,
   as a quiet button.
3. **My clients**: `PageHead` (title + ⓘ) instead of the long header; the book (search, Add a
   client, the list) first, then Your link, Your WhatsApp, Working hours, Social accounts. On a
   phone (≤ 640px) each client is a two-line row: name (and opted-out tag) with Hand back on the
   first line, number · company · last heard on the second; no sideways scroll.
4. **Knowledge**: the failed-sources warning, then "What it knows", then the list; "Teach it
   something" folded behind "+ Teach it something" (AddFold; `?add=1` opens it; saving closes it).
   Source rows a little tighter.
5. **Answer rules**: the counters as the slim pill strip Follow-ups uses, hidden under a failed
   load; "Write one yourself" folded behind "+ Write one yourself" (AddFold; saving closes it).

## Calls I made (owner can change any)
- Forecast is included: same staff bug, one line to fix.
- My clients puts the book first and the set-up panels after it.
- Customers keeps Import where it is (a quiet button), not moved into a menu.
- Phone-only change for the My clients table; wider screens keep the table.

## Testing
Render test for the hook's pure decision (`pageBusinessFor`); source pins that each page uses it
and waits; AddFold on Knowledge and Answer rules; PageHead on My clients and the book before the
panels; CSS pins for the phone rows and denser cards; counts gated on loadError. Web suite and
typecheck; the preview as staff and admin at 375 and 1440px, with request URLs checked.

## Rollout
Web only, no migration. Deploy only on the owner's "Deploy it".
