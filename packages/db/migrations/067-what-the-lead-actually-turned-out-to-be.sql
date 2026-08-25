-- Lead labels: the last open sub-item on F3.
--
-- ============================================================
-- "MODEL SECOND ONCE LABELS EXIST"
-- ============================================================
--
-- That row has said so since this platform started, and nothing in it ever
-- produced a label. The scorer is rules over keywords; `lead_assessments` holds
-- what it decided; and there has never been anywhere to record whether it was
-- right. So "once labels exist" was a condition nobody could reach.
--
-- This is the missing half. It is not a model and it does not pretend to be one.
-- It is the only thing that makes a model possible later AND the only thing that
-- makes the current rules judgeable now -- which is the more immediately useful
-- of the two, because a rules scorer nobody has ever checked is indistinguishable
-- from a good one.
--
-- ============================================================
-- WHY THE QUESTION IS BINARY
-- ============================================================
--
-- The obvious label is "what should the priority have been", using the same four
-- values the scorer produces. That asks a person to do the scorer's job from
-- memory, and the answers would be noise -- the difference between "high" and
-- "urgent" a fortnight later is not a thing anybody knows.
--
-- "Was this worth a person's time" is a question whoever handled it can answer
-- reliably, in one click, months later. It is also exactly the signal a model
-- would train on. The optional outcome adds detail for anyone who wants to give
-- it, and nothing depends on it being filled in.

create table if not exists lead_labels (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  -- The assessment being judged, not the contact. One contact can be assessed
  -- many times and the whole point is to judge each verdict against what
  -- happened, rather than to attach a standing opinion to a person.
  assessment_id   uuid not null references lead_assessments(id) on delete cascade,

  -- THE LABEL. Everything else on this row is optional detail.
  worth_attention boolean not null,

  -- Detail for anyone who wants to give it. Deliberately nullable: a label that
  -- required an outcome would be a label nobody fills in, and the binary above
  -- is the part that carries the signal.
  outcome         text check (outcome is null or outcome in ('won', 'lost', 'no_reply', 'not_a_lead')),
  note            text,

  -- A person, always. A judgement nobody signed is one nobody can be asked
  -- about, and this is training data for something that will later decide what
  -- customers get attention.
  labelled_by     text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One label per assessment. A second opinion overwrites rather than doubling
-- the row's weight in every count that reads this table -- and a disagreement
-- between two colleagues is a conversation, not a statistic.
create unique index if not exists lead_labels_one_per_assessment
  on lead_labels (assessment_id);

create index if not exists idx_lead_labels_org
  on lead_labels (organization_id, created_at desc);

alter table lead_labels enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'lead_labels' and policyname = 'lead_labels_tenant_isolation') then
    create policy lead_labels_tenant_isolation on lead_labels
      using (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all')
      with check (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all');
  end if;
end $$;

grant select, insert, update, delete on lead_labels to nexus_app;
