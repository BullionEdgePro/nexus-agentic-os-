# An admin connects everything a staff member can — design

Date: 3 Nov 2026. Taken under the owner's standing "go with my recommendation"; every
choice below is the recommended one and can be overridden.

## What it is for

The owner asked: "add connection in admin like in staff, be reliable" and "admin also can
connect everything like staff". It started from wanting +971 50 480 5436 under Atif Ali so
it can send in Bulk messaging.

Today an admin opening Connections is refused: "An owner has no personal account here". Every
connection — WhatsApp Business (coexistence), Gmail, business email (IMAP), TikTok, and the
business-level Facebook Page and Instagram — is filed under one person in one business,
`(organization_id, employee_id)`. That is what routes a message on a person's WhatsApp
number to them, what fills their mail, and what lists their number in Bulk.

**Outcome:** an admin opens Connections, picks a business, and connects any of the same
accounts a staff member can, through the same screens and the same server code. Their
WhatsApp number then appears in that business's Bulk "Send from" list as
"<admin name> · <number>", and messages to it land in that business's inbox as theirs.

Assumed: a connection belongs to one business at a time (the admin picks it), because chats,
mail and Bulk are all per business; nothing auto-assigns customers to an admin.

Out of scope: the payment-method problem on the WhatsApp account (fixed by the owner in Meta
Business Suite); re-registering a number with Meta (Meta's own window, the owner's phone).

## 1. The admin's seat

- Migration 108: `employees.admin_id uuid references admins(id) on delete set null`, with a
  partial unique index on `(organization_id, admin_id) where admin_id is not null` — one seat
  per admin per business.
- `findAdminSeat(adminId, organizationId)` reads it; `ensureAdminSeat(admin, organizationId)`
  finds or creates it:
  1. the row already linked by `admin_id`;
  2. else an ACTIVE staff record in that business whose email matches the admin's
     (case-insensitive) and is not linked to another admin — linked, not duplicated (Atif Ali
     may already be on a team);
  3. else a new record: the admin's full name and email, job title "Admin",
     `employee_code` `admin-<first 8 of the admin id>`, no working hours, no access code
     (so nobody can sign in to it as staff).
- A seat is an ordinary staff record otherwise, so every existing staff flow works on it
  unchanged. `Employee.adminId` carries the link.

## 2. Connections for an admin

- The admin's session already carries `adminId`. Every `/api/connections` route resolves its
  owner through one async `ownerFor(c, { create })`:
  - staff: unchanged (their own record);
  - admin: `?business=<slug>` names the business; listing reads the seat without creating
    one (no seat = nothing connected yet); starting or finishing a connection creates it;
  - admin without a business, or an unknown slug: 400 "Choose which business to connect
    for." / 404 "Business not found.".
- OAuth returns carry the seat in the signed state, as today. A return for an admin's seat
  goes back to `/deck/connections` (staff keep `/deck/my-clients`, which admins cannot open).
- Web: Connections appears in the admin's sidebar too. For an admin the page shows a business
  picker above the same cards ("Connect for: SFS International"), remembered per browser,
  and every call carries the chosen business. Staff see no picker and no change.

## 3. Reliability rules

- **A line held by a person wins.** Inbound routing checks a person's line before a
  business's own line (today it is the other way round). If the admin connects a number that
  is also a business's old shared line (the same Meta id), messages reach the admin, not the
  old five-business switchboard.
- Bulk's `numbersOf` does not offer "The business's own number" when that same line is held
  by a person (otherwise reconnecting the old shared line would bring it back for all five
  businesses at once).
- A business's LIVE shared line (not switched off) can still never be connected to one
  person — refused in the connect flow with the Team screen's words. A switched-off one may.
- **Admin seats are never auto-assigned customers**: they are left out of auto-assignment
  candidates.
- Team shows a seat with an "Admin" label so nobody mistakes it for a hire.

## Testing

- DB: `ensureAdminSeat` creates once and returns the same seat after (one per business),
  links an existing same-email staff record instead of duplicating, never links one already
  linked to another admin, and makes a seat that cannot sign in (no access code).
- API: `ownerFor` for staff unchanged; admin + business resolves the seat (created only when
  asked); admin without a business → 400; unknown business → 404. The listing for an admin
  with no seat is empty, not an error.
- Routing: a number held by a person and also a business's line goes to the person;
  a business line nobody holds still goes to the business.
- Bulk: the business's own number is not listed when a person holds it.
- Connect: a live shared line is refused; a switched-off one is accepted.
- Auto-assignment skips seats.
- Web: the admin sees Connections in the sidebar and a business picker; staff see neither
  change; every connections call carries the business for an admin.
- Browser (local mock): admin and staff Connections pages in Cream and Warm Night, 1280 and
  375 px.

## Deploy

Only on the owner's "Deploy it": merge, push main, on the VPS `git pull` → backup →
`psql` migration 108 as the owner (ON_ERROR_STOP) → schema-drift-check → `deploy.sh`. Then
the owner connects +971 50 480 5436 from Connections (Meta's window, the code on that phone),
and fixes the payment method in Meta Business Suite so Bulk can start conversations.
