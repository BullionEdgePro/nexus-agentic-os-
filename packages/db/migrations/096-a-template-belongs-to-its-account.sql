-- ============================================================
-- A template belongs to its WhatsApp account
-- ============================================================
--
-- A WhatsApp template lives on ONE WhatsApp Business Account, and Meta refuses
-- a template sent from a number on another one. The mirror stored templates per
-- business only, read from the business's account. On 12 Oct 2026 a staff
-- member's own number (+971 52 563 1476) joined through Coexistence on a
-- DIFFERENT account (1915340836093863, under the SFS portfolio) that held no
-- templates — and My campaigns still offered Zipicka's, so every staff bulk send
-- from it would have been refused per recipient.
--
-- So a template row records its account, a staff number records its account,
-- and the same template name may now exist once per account rather than once
-- per business. Existing rows were all read from their business's account, so
-- that is what they are backfilled with.

alter table message_templates add column if not exists whatsapp_business_account_id text;

update message_templates t
   set whatsapp_business_account_id = o.whatsapp_business_account_id
  from organizations o
 where o.id = t.organization_id
   and t.whatsapp_business_account_id is null;

alter table message_templates
  drop constraint if exists message_templates_organization_id_meta_template_name_langua_key;
create unique index if not exists idx_message_templates_account_name
  on message_templates (organization_id, coalesce(whatsapp_business_account_id, ''), meta_template_name, language);

alter table employees add column if not exists whatsapp_business_account_id text;

-- The one staff number connected before this column existed.
update employees
   set whatsapp_business_account_id = '1915340836093863'
 where whatsapp_phone_number_id = '1358680447321869'
   and whatsapp_business_account_id is null;

do $$
begin
  raise notice 'templates and staff numbers now carry their WhatsApp account';
end $$;
