-- ============================================================
-- Migration 013 — Leads that arrive on an employee's own phone
-- ============================================================
--
-- The platform runs ONE WhatsApp Business number for all five businesses, and
-- that is staying. Employees reach customers from the WhatsApp already on their
-- phone (migration 011 / packages/employees/direct-contact.ts), which is cheap
-- and instant — and until now completely invisible here. A conversation that
-- moved to a personal number left no trace: no lead, no score, no attribution.
--
-- So an employee who wins business on their own phone generated nothing the
-- platform could see, and the pipeline showed only what happened to arrive on
-- the CRM number. That is a reporting hole shaped exactly like a sales team.
--
-- This lets a lead be captured from a personal-phone conversation and scored by
-- the same rules engine as an inbound one, attributed to the employee who
-- brought it in.
--
-- Additive and idempotent.

-- Who captured this lead, and through which channel.
--
-- `source` is deliberately not a boolean. "Did an employee log this?" and "did
-- this arrive on the CRM number?" are different questions today and will keep
-- diverging as channels are added, and a boolean would have to be renamed the
-- first time a third one appears.
alter table lead_assessments
  add column if not exists employee_id uuid references employees(id) on delete set null;

alter table lead_assessments
  add column if not exists source text not null default 'inbound'
  check (source in ('inbound', 'employee_direct'));

-- `note` holds what the employee actually typed about the enquiry. The scoring
-- signals are derived from it, so keeping the raw text means a score can be
-- explained — and re-derived if the rules change.
alter table lead_assessments
  add column if not exists note text;

create index if not exists idx_lead_assessments_employee
  on lead_assessments(employee_id, created_at desc)
  where employee_id is not null;

create index if not exists idx_lead_assessments_source
  on lead_assessments(organization_id, source, created_at desc);

-- ------------------------------------------------------------
-- Contacts who never messaged the CRM number
-- ------------------------------------------------------------
--
-- A contact captured this way has no conversation and no messages — they exist
-- because an employee met them on a personal phone. `contacts.wa_id` is still
-- the right identity: it is the customer's WhatsApp number either way, so if
-- they later message the shared number the existing (organization_id, wa_id)
-- unique constraint merges the two automatically rather than creating a
-- duplicate. That merge is the reason this reuses `contacts` instead of adding
-- a separate table.
alter table contacts
  add column if not exists captured_by_employee_id uuid references employees(id) on delete set null;

alter table contacts
  add column if not exists captured_at timestamptz;

-- ------------------------------------------------------------
-- Assert the shape, not just the absence of errors
-- ------------------------------------------------------------
do $$
declare
  missing text;
begin
  select string_agg(want.tbl || '.' || want.col, ', ')
    into missing
    from (values
      ('lead_assessments', 'employee_id'),
      ('lead_assessments', 'source'),
      ('lead_assessments', 'note'),
      ('contacts', 'captured_by_employee_id'),
      ('contacts', 'captured_at')
    ) as want(tbl, col)
   where not exists (
     select 1 from information_schema.columns
      where table_name = want.tbl and column_name = want.col
   );

  if missing is not null then
    raise exception 'Migration 013 incomplete — missing: %', missing;
  end if;

  raise notice 'Employee-sourced leads ready: assessments carry employee_id + source, contacts carry capture attribution';
end
$$;
