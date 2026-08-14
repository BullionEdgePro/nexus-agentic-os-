-- Appointments the agent can actually make.
--
-- `book_appointment` has been a stub since the tool list was written, because
-- no booking backend had been chosen. The choice made on 2026-08-13 was the
-- platform's own database rather than Google Calendar or Cal.com: no third
-- party to authenticate, nothing to keep in sync, and bookings appear in the
-- deck beside the conversation that produced them.
--
-- Four of the five businesses need this — attestation appointments, legal
-- consultations, property viewings, case consultations. Zipicka is retail and
-- largely does not.

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  -- Who it is for. The contact is required; a booking with nobody to meet is
  -- not a booking. The employee is nullable so a business can take a booking
  -- before deciding who covers it — the same shape follow-ups already use.
  contact_id uuid not null references contacts(id) on delete cascade,
  employee_id uuid references employees(id) on delete set null,

  -- The conversation it came out of, kept so an operator reading a booking can
  -- see what was actually agreed. Nullable because a booking may be entered by
  -- hand from the deck.
  conversation_id uuid references conversations(id) on delete set null,

  starts_at timestamptz not null,
  ends_at timestamptz not null,

  -- 'confirmed' on creation. Cancellations are a status change, never a delete:
  -- a customer who was told 3pm and then finds nothing on record has no way to
  -- tell a cancellation from a system that lost their booking.
  status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),

  subject text,
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An appointment that ends before it starts is not a scheduling preference.
  constraint bookings_end_after_start check (ends_at > starts_at)
);

-- Double-booking is prevented HERE, in the database, and deliberately not in
-- application code.
--
-- The obvious implementation — read the employee's bookings, see if the slot is
-- free, then insert — is a race. Two customers messaging at the same moment
-- both read an empty slot, both find it free, and both are told they have it.
-- Nothing errors. Each conversation reads perfectly. The employee finds two
-- people waiting, and the system that produced the clash has no record that
-- anything went wrong.
--
-- That is the exact failure shape this platform has been finding all week: a
-- correct-looking result that nobody can tell is wrong. So the guarantee lives
-- where concurrency cannot defeat it. Postgres will refuse the second insert.
--
-- Scoped to CONFIRMED bookings only — a cancelled slot must become bookable
-- again — and to rows that name an employee, since an unassigned booking is not
-- yet anybody's time.
create extension if not exists btree_gist;

alter table bookings drop constraint if exists bookings_no_double_booking;
alter table bookings add constraint bookings_no_double_booking
  exclude using gist (
    employee_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
  where (status = 'confirmed' and employee_id is not null);

create index if not exists bookings_org_starts_idx
  on bookings (organization_id, starts_at desc);
create index if not exists bookings_employee_starts_idx
  on bookings (employee_id, starts_at desc)
  where status = 'confirmed';
create index if not exists bookings_contact_idx on bookings (contact_id);

-- Tenant isolation, matching every other business-owned table. Without this a
-- booking is readable across businesses, and under DB_TENANT_ASSERT=strict an
-- unscoped query against it throws rather than silently returning nothing.
alter table bookings enable row level security;
drop policy if exists bookings_tenant_isolation on bookings;
create policy bookings_tenant_isolation on bookings
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

grant select, insert, update on bookings to nexus_app;
