-- A staff member's own client book, and their own way of reaching it.
--
-- ============================================================
-- WHAT WAS ASKED FOR, AND THE ONE PART THAT CANNOT BE BUILT
-- ============================================================
--
-- The ask: staff keep their own clients here, connect their own WhatsApp so
-- they see those people messaging them, and bulk-message their own book.
--
-- Two of those three are ordinary features and are built here. The third has a
-- hard edge that is worth writing down where it cannot be lost, because every
-- future reader will otherwise re-propose the impossible version:
--
--   A STAFF MEMBER'S PERSONAL WHATSAPP CANNOT BE CONNECTED. The consumer app
--   has no API. The libraries that claim otherwise drive a logged-in web
--   session, which breaks WhatsApp's terms, and the ban that follows is applied
--   to the BUSINESS, not just the number that misbehaved. This platform has one
--   GREEN-rated number serving six businesses; risking it to save a staff
--   member a step is not a trade anybody would make twice.
--
--   What CAN be connected is a number registered on the WhatsApp Business
--   Account. Sending is already `POST /{phone_number_id}/messages` and inbound
--   already routes on `phone_number_id`, so the platform needed no change to
--   support more than one number -- only a way to say WHOSE a number is. That
--   is `employees.whatsapp_phone_number_id`, which has existed since migration
--   001 and has never been populated. This migration gives it the surrounding
--   columns it needed to be usable, and the code gives it a meaning.
--
-- Until the owner adds a second number in Meta Business Manager, every staff
-- member sends from the shared company number. The console says so in those
-- words rather than implying a private channel that does not exist.
--
-- ============================================================
-- OWNERSHIP IS NOT AUTHORSHIP
-- ============================================================
--
-- `contacts.captured_by_employee_id` already exists and is NOT reused here. It
-- records who first brought a person in -- an audit fact, true for ever, and
-- correctly unchanged when somebody leaves. `owner_employee_id` is an ACCESS
-- RULE and has to move when a book is handed over. Storing an access decision
-- in an audit column is how, two years from now, reassigning a client silently
-- rewrites who is recorded as having found them.
--
-- NULL owner means the business's shared pool -- every contact that exists
-- today. That is the safe default: this migration changes nobody's visibility
-- on the day it runs.
--
-- ============================================================
-- WHY THE SCOPING IS NOT IN THE POLICY
-- ============================================================
--
-- Row-level security here isolates TENANTS, keyed on `app.current_org`. The
-- obvious extension is an `app.current_employee` and a policy clause, and it
-- was rejected: every worker, operator sweep and webhook path runs without an
-- employee, so such a policy must pass when the variable is unset -- which
-- means a single forgotten `set_config` in the API silently shows one staff
-- member another's book, with no error anywhere.
--
-- The same failure has already happened once on this platform, on the serving
-- -tenant read path, and the fix was a predicate defined ONCE and a gate that
-- fails the build when a query touching that table omits it. Employee scoping
-- follows that proven shape rather than inventing a second mechanism:
-- `contactOwnedBy()` in packages/db/src/contacts.ts, enforced by
-- apps/api/test/whose-client-is-this.test.mjs.

-- ------------------------------------------------------------
-- The client book
-- ------------------------------------------------------------

alter table contacts
  add column if not exists owner_employee_id uuid references employees(id) on delete set null;

comment on column contacts.owner_employee_id is
  'The staff member whose private client this is. NULL means the business''s shared pool. '
  'An ACCESS rule, not an audit fact -- see captured_by_employee_id for who first brought them in.';

-- Partial: the shared pool is the overwhelming majority and is served by the
-- existing organization indexes. This one exists for "my clients", which is
-- always a small slice and always filtered on both columns.
create index if not exists idx_contacts_owner
  on contacts(organization_id, owner_employee_id)
  where owner_employee_id is not null;

-- ------------------------------------------------------------
-- Their own channel
-- ------------------------------------------------------------
--
-- `whatsapp_phone_number_id` and `whatsapp_number` are already on the table.
-- What was missing is any way to tell "a number somebody typed in" from "a
-- number Meta confirmed is live on our account" -- and only the second can send
-- anything. Recorded separately so the console can show the difference instead
-- of showing a hopeful blank.

alter table employees
  add column if not exists whatsapp_verified_name  text,
  add column if not exists whatsapp_connected_at   timestamptz,
  add column if not exists whatsapp_quality_rating text;

comment on column employees.whatsapp_verified_name is
  'The display name Meta returns for this number. Present only once the number has been confirmed to exist on the WABA.';
comment on column employees.whatsapp_connected_at is
  'When the number was last confirmed against Meta. NULL means never confirmed -- the number is aspirational, not usable.';
comment on column employees.whatsapp_quality_rating is
  'GREEN / YELLOW / RED as Meta last reported. A number that has gone RED is rate-limited by Meta and should not be used for a campaign.';

-- ------------------------------------------------------------
-- Bulk messaging, and the reason it is off by default
-- ------------------------------------------------------------
--
-- A staff broadcast from the shared number spends the company's money and, far
-- more expensively, spends the company's QUALITY RATING -- which is one number
-- for all six businesses. One person mass-messaging a stale list can move the
-- shared number to YELLOW and throttle every other business's real replies.
--
-- So it is a permission the owner grants, not a capability every new hire has
-- on their first afternoon, and it carries a monthly ceiling. `false` and a
-- default cap are the values every existing staff member gets today.

alter table employees
  add column if not exists can_broadcast          boolean not null default false,
  add column if not exists broadcast_monthly_cap  integer not null default 200;

comment on column employees.can_broadcast is
  'Whether this person may send campaigns. Off by default: a staff broadcast spends the shared number''s quality rating, which every business depends on.';
comment on column employees.broadcast_monthly_cap is
  'Ceiling on recipients per calendar month for this person. Counted from broadcast_recipients, not from intent.';

alter table employees
  drop constraint if exists employees_broadcast_cap_check;
alter table employees
  add constraint employees_broadcast_cap_check
  check (broadcast_monthly_cap >= 0 and broadcast_monthly_cap <= 10000);

-- ------------------------------------------------------------
-- Whose campaign was this, and what did it actually go out from
-- ------------------------------------------------------------

alter table broadcasts
  add column if not exists employee_id           uuid references employees(id) on delete set null,
  add column if not exists from_phone_number_id  text;

comment on column broadcasts.employee_id is
  'The staff member who owns this campaign. NULL means the business sent it. Their client book is the audience.';

-- Frozen at send rather than derived from the employee when somebody later asks
-- "which number did this go out from". A number can be reassigned, a staff
-- member can leave, and the answer to that question must not change afterwards.
comment on column broadcasts.from_phone_number_id is
  'The number this campaign was actually sent from, stamped when it was queued. Never recomputed -- reassigning a number must not rewrite history.';

create index if not exists idx_broadcasts_employee
  on broadcasts(employee_id, created_at desc)
  where employee_id is not null;
