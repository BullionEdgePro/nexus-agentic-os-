-- ============================================================
-- 027 — Operators (F8)
--
-- An operator is a named check that runs on a schedule and produces FINDINGS:
-- things a person should look at. This is the platform's first mechanism where
-- something happens without a customer message arriving first — everything
-- before it was reactive.
--
-- THE §2.3 QUESTION, ANSWERED BY CONSTRUCTION. The architecture doc blocked F8
-- on "event-triggered or paid inference?", because autonomous agents polling a
-- model is an inference bill that scales with tenants and with time. These
-- operators run no inference at all: every one is SQL over data the platform
-- already has. That does not decide the paid-inference question — it removes
-- the need to decide it before shipping anything.
--
-- THE PROPERTY THAT MAKES THIS WORTH BUILDING. A finding can be RETRACTED.
-- Each run computes what is true now and reconciles: new findings are opened,
-- ones that still hold are touched, and ones that no longer hold are resolved.
-- An alert list that only grows is one people stop reading within a week, and a
-- list nobody reads is indistinguishable from no list — while looking like a
-- working feature. That is this codebase's signature failure and it is designed
-- out here rather than patched later.
--
-- `fingerprint` is what makes that possible: a stable identifier for the THING
-- being reported, within one operator and one business. The same overdue
-- follow-up seen on twenty consecutive runs is one row whose last_seen_at
-- moves, not twenty rows.
-- ============================================================

create table if not exists operator_findings (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,

  -- Which operator said so. A slug, not a foreign key: operators are code, and
  -- a registry table would be a second place to keep the same list correct.
  operator          text not null,

  -- Stable identity of the subject within (organization, operator). Usually the
  -- id of the row being reported on.
  fingerprint       text not null,

  severity          text not null default 'warn'
                    check (severity in ('info', 'warn', 'urgent')),

  title             text not null,
  detail            text,

  -- What it points at, so the UI can link somewhere useful. Nullable and NOT a
  -- foreign key on purpose — a finding may outlive its subject, and a finding
  -- that vanishes when the row it warned about is deleted is the one you most
  -- wanted to keep.
  subject_kind      text,
  subject_id        uuid,

  -- first_seen_at answers "how long has this been true", which is most of the
  -- signal. It RESETS when a resolved finding recurs: something that came back
  -- yesterday is not three weeks old, and reporting it as three weeks old would
  -- be worse than not reporting the age at all.
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  resolved_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The key reconciliation depends on. Without it, "the same finding again"
-- cannot be recognised and every run inserts duplicates.
create unique index if not exists uq_operator_findings_identity
  on operator_findings (organization_id, operator, fingerprint);

-- The read the page makes: open findings for a business, worst first.
create index if not exists idx_operator_findings_open
  on operator_findings (organization_id, severity, first_seen_at)
  where resolved_at is null;

drop trigger if exists trg_operator_findings_updated_at on operator_findings;
create trigger trg_operator_findings_updated_at before update on operator_findings
  for each row execute function set_updated_at();

-- A finding names a customer, a conversation or a commitment, so it carries the
-- same isolation as everything else that does.
alter table operator_findings enable row level security;
drop policy if exists operator_findings_tenant_isolation on operator_findings;
create policy operator_findings_tenant_isolation on operator_findings
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

do $$
declare
  guarded boolean;
begin
  select relrowsecurity into guarded from pg_class where relname = 'operator_findings';
  if not coalesce(guarded, false) then
    raise exception 'operator_findings was created without row-level security';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'uq_operator_findings_identity') then
    raise exception 'the identity index is missing — reconciliation would duplicate every run';
  end if;
  raise notice 'operators ready, tenant-isolated';
end $$;
