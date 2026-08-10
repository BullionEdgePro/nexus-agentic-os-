-- ============================================================
-- 020 — Shared patterns (F5, the Neural Brain's store)
--
-- What every business has learned, pooled so a new tenant does not start blind.
-- The premise is that "attestation questions escalate to a human 60% of the
-- time" is useful to a business that has never handled one.
--
-- THE COLUMN THAT MAKES THIS HONEST: `contributing_tenants`.
--
-- Today one of five businesses has customer traffic. Without that count, a
-- pooled table would aggregate Zipicka's conversations, label the result
-- "platform intelligence", and hand it back to Zipicka as though four other
-- companies had corroborated it. That is not learning, it is a mirror with a
-- confident caption — and it is the exact failure mode §8 describes: a plausible
-- normal state, no error, and a number nobody can tell is wrong.
--
-- So a pattern is only usable as shared guidance once at least two distinct
-- businesses have contributed to it. Below that it is still stored — it will
-- qualify later — but it is not shared knowledge and must not be presented as
-- such. The read path enforces this; see `getSharedGuidance`.
--
-- NO organization_id, deliberately. This table is the one place in the schema
-- where rows are not owned by a tenant, which is why it is also the one place
-- where what may be written is an allow-list rather than a judgement call:
-- every column here corresponds to a field in `SHAREABLE`
-- (packages/governance/src/redact.ts). Nothing a customer or employee wrote can
-- reach this table, because no free-text column exists to receive it.
--
-- Consequently this table is NOT in TENANT_SCOPED_TABLES and gets no RLS
-- policy. That is correct rather than an oversight: it holds no tenant rows.
-- ============================================================

create table if not exists shared_patterns (
  -- The pattern's identity: what kind of enquiry, in what language.
  intent_category       text not null,
  language              text not null default 'en',

  -- Aggregates. Counts only — nothing that could reconstruct a conversation.
  sample_count          integer not null default 0,
  escalated_count       integer not null default 0,
  avg_resolution_seconds integer,
  avg_message_count     numeric(6,2),

  -- How many distinct businesses contributed. The guard described above.
  contributing_tenants  integer not null default 0,

  computed_at           timestamptz not null default now(),

  primary key (intent_category, language)
);

create index if not exists idx_shared_patterns_shareable
  on shared_patterns (contributing_tenants desc, sample_count desc);

do $$
declare
  total integer;
  shared integer;
begin
  select count(*) into total from shared_patterns;
  select count(*) into shared from shared_patterns where contributing_tenants >= 2;
  raise notice 'Shared patterns: % stored, % qualify as cross-tenant guidance', total, shared;
  if total > 0 and shared = 0 then
    raise notice 'None qualify yet — only one business has traffic. This is expected, not a fault.';
  end if;
end $$;
