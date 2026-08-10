-- ============================================================
-- 017 — message templates become a mirror of Meta, not a local record
--
-- The table already existed with `is_approved boolean`, which someone had to
-- set by hand. That is the wrong shape for this fact: Meta decides whether a
-- template may be sent, Meta can withdraw approval at any time, and a boolean
-- typed in by an operator records what they believed rather than what is true.
-- A stale `true` here means a bulk send that fails at the last hop, after the
-- broadcast row, the recipient rows and the queue jobs all exist.
--
-- So the columns below let the row carry Meta's own answer:
--
--   meta_template_id  — the template's id at Meta, the only stable identity.
--                       Names are reused across languages and can be recreated.
--   status            — Meta's verbatim status (APPROVED / PENDING / REJECTED /
--                       PAUSED / DISABLED), kept as text rather than collapsed
--                       to a boolean, because "why can I not send this" is a
--                       question the boolean cannot answer.
--   body_param_count  — how many {{n}} placeholders the approved body has. A
--                       send whose parameter count differs is rejected outright
--                       by Meta, so the count has to travel with the template.
--   synced_at         — when we last heard from Meta. Absent it, an empty list
--                       is indistinguishable from a sync that never ran.
--
-- `is_approved` stays, derived from `status`, so nothing that reads it breaks.
-- Re-runnable: this file is applied on every deploy.
-- ============================================================

alter table message_templates add column if not exists meta_template_id text;
alter table message_templates add column if not exists status           text;
alter table message_templates add column if not exists body_param_count integer not null default 0;
alter table message_templates add column if not exists synced_at        timestamptz;

-- Rows that predate the sync have no status; treat their existing boolean as
-- the best answer available rather than silently marking them unapproved.
update message_templates
   set status = case when is_approved then 'APPROVED' else 'UNKNOWN' end
 where status is null;

-- One row per template per organization. The same Meta template is offered to
-- several businesses (they share one WhatsApp account), so the identity here is
-- the pair, not the template alone.
create unique index if not exists idx_message_templates_org_meta
  on message_templates (organization_id, meta_template_id)
  where meta_template_id is not null;

create index if not exists idx_message_templates_status on message_templates (status);

do $$
declare
  approved integer;
begin
  select count(*) into approved from message_templates where status = 'APPROVED';
  raise notice 'Template mirror ready: % approved template row(s) currently stored', approved;
end $$;
