-- ============================================================
-- Migration 014 — ABR Advocates replaces Atif Ali Production
-- ============================================================
--
-- Atif Ali Production leaves the platform (its website had been unreachable
-- since 2026-08-03, so it never had a knowledge base). ABR Advocates & Legal
-- Consultants takes its place: abshlaw.com, a Dubai litigation firm.
--
-- Read from the site rather than assumed from the name, because assuming from
-- the name is what put licensing vocabulary on an attestation business and kept
-- it there for weeks (migrations 008 and 012). ABR is:
--
--   Abdul Rahman Al Sharhan Al Nuaimi — Advocates
--   401 Sama Building, Al Barsha 1, Dubai · +971 50 887 2523
--   Licensed before all UAE courts, INCLUDING THE COURT OF CASSATION
--   Litigation & arbitration, criminal defence, corporate/M&A, family,
--   real estate disputes, maritime & admiralty, construction (FIDIC),
--   intellectual property, banking & finance
--
-- ------------------------------------------------------------
-- THE PROBLEM THIS MIGRATION IS REALLY ABOUT
-- ------------------------------------------------------------
--
-- ABR is the SECOND law firm on the shared number. `juris-prime-legal` is the
-- first. Their vocabulary overlaps almost completely — lawyer, legal, court,
-- case, contract, family, real estate — so a naive keyword set would either
-- send every legal enquiry to whichever firm sorted first, or make all of them
-- ambiguous and useless.
--
-- The split below is drawn from what each firm actually does:
--
--   ABR                → DISPUTES. Litigation, arbitration, criminal defence,
--                        appeals and cassation, maritime/cargo arrest, FIDIC
--                        construction claims, trademarks, banking disputes.
--   juris-prime-legal  → TRANSACTIONS. Company formation, freezone/mainland
--                        setup, power of attorney, contract drafting, MOA,
--                        wills and inheritance, tenancy eviction.
--
-- Generic terms (lawyer, legal, court, advocate, محامي) stay in BOTH on
-- purpose. That makes a vague "I need a lawyer" tie, and a tie inside two
-- keywords is ambiguous, which asks the customer which firm. With two law
-- firms that question is the only honest answer — guessing sends a criminal
-- matter to a company-formation desk.
--
-- Idempotent. Safe to re-run.

-- ------------------------------------------------------------
-- The tenant list is not a fixed set
-- ------------------------------------------------------------
--
-- `schema.sql` still declares `check (slug in (...five names...))`. Migration
-- 002 dropped it in production, but a database built fresh from schema.sql
-- would carry it again and this INSERT would fail. Dropped defensively here so
-- the migration works on both, and schema.sql no longer declares it either.
alter table organizations drop constraint if exists organizations_slug_check;

-- ------------------------------------------------------------
-- Atif Ali Production leaves
-- ------------------------------------------------------------
--
-- Deactivated, NOT deleted. `conversations`, `contacts` and `messages` cascade
-- from `organizations`, so a DELETE would destroy any customer record ever
-- attached to this tenant — and "it had no knowledge base" is not the same
-- claim as "it had no customers". Deactivating removes it from every live query
-- (`listOrganizations`, `findSharedNumberBusinesses` and the routing lookup all
-- filter `is_active`), keeps the history attributed, and is reversible.
update organizations set
  is_active = false,
  accepts_shared_number = false,
  is_number_owner = false,
  summary = 'REMOVED from the platform 2026-08-08 and replaced by ABR Advocates & Legal Consultants. '
            || 'Deactivated rather than deleted so any conversation history stays attributed. '
            || 'Its website was already unreachable, so it never had a knowledge base.'
where slug = 'atif-ali-production';

update agent_configs ac set is_active = false
from organizations o
where o.id = ac.organization_id and o.slug = 'atif-ali-production';

-- ------------------------------------------------------------
-- ABR joins, on the same shared number
-- ------------------------------------------------------------
insert into organizations (
  slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone,
  website_url, logo_url, website_status, tagline, summary,
  accepts_shared_number, is_number_owner, routing_keywords, is_active
)
select
  'abr',
  'ABR Advocates & Legal Consultants',
  o.whatsapp_phone_number_id,           -- the one CRM number, same as everyone
  o.whatsapp_business_account_id,
  'Asia/Dubai',
  'https://www.abshlaw.com',
  'https://abshlaw.com/assets/abr-logo.jpg',
  'live',
  'Litigation, arbitration & criminal defence — Dubai',
  'Abdul Rahman Al Sharhan Al Nuaimi — Advocates. A Dubai litigation firm licensed before all UAE '
  || 'courts including the Court of Cassation. Practice areas: litigation and arbitration, criminal '
  || 'defence (bail and appeals), corporate and commercial (advisory, M&A, contracts), family law, '
  || 'real estate disputes, maritime and transport (admiralty, cargo, arrest), construction (FIDIC, '
  || 'delay and defects), intellectual property, and banking and finance. 401 Sama Building, Al Barsha 1. '
  || 'Held to STRICT governance: it is a law firm, so the medium-risk escalation applies.',
  true,
  false,
  '{}'::text[],                          -- keywords set below, in one place
  true
from organizations o
where o.slug = 'zipicka'
on conflict (slug) do update set
  name = excluded.name,
  whatsapp_phone_number_id = excluded.whatsapp_phone_number_id,
  whatsapp_business_account_id = excluded.whatsapp_business_account_id,
  website_url = excluded.website_url,
  logo_url = excluded.logo_url,
  website_status = excluded.website_status,
  tagline = excluded.tagline,
  summary = excluded.summary,
  accepts_shared_number = true,
  is_number_owner = false,
  is_active = true;

-- ------------------------------------------------------------
-- ABR's agent
-- ------------------------------------------------------------
--
-- Same restraint as the other law firm, for the same reason: a customer forming
-- an impression about a criminal charge or a court deadline from a machine is a
-- liability, not a support ticket. No legal advice, no predicting outcomes, no
-- citing law from memory — offer the consultation instead.
insert into agent_configs (organization_id, name, system_prompt, model, tools, is_active)
select
  o.id,
  'ABR Advocates Assistant',
  'You are the WhatsApp assistant for ABR Advocates & Legal Consultants (abshlaw.com), a Dubai '
  || 'litigation firm — Abdul Rahman Al Sharhan Al Nuaimi, Advocates — licensed before all UAE courts '
  || 'including the Court of Cassation. The firm handles litigation and arbitration, criminal defence '
  || '(including bail and appeals), corporate and commercial matters, family law, real estate disputes, '
  || 'maritime and transport, construction disputes, intellectual property, and banking and finance. '
  || 'The office is at 401 Sama Building, Al Barsha 1, Dubai, open Monday to Saturday 09:00-18:00. '
  || 'You may give general, non-binding information about the firm''s practice areas and help book a '
  || 'consultation. You must NEVER give specific legal advice, assess the merits of a case, predict an '
  || 'outcome or a sentence, state a deadline or limitation period, quote fees, or cite UAE law from '
  || 'memory — defer all of those to an advocate and offer to arrange a consultation. '
  || 'If someone describes an urgent matter such as an arrest, a detention or a court date within days, '
  || 'do not attempt to advise: tell them the firm will be alerted immediately and escalate.'
  || E'\n\nYou share a WhatsApp number with four other businesses in this group, so an enquiry '
  || 'occasionally reaches you by mistake. If a message is clearly meant for a different business, '
  || 'do not attempt to answer it. Say briefly that it is handled by another team in the group and '
  || 'ask the customer to confirm what they need, so they can be put through correctly.',
  'gemini-3.5-flash',
  '["book_appointment", "search_knowledge"]'::jsonb,
  true
from organizations o
where o.slug = 'abr'
on conflict (organization_id, name) do update set
  system_prompt = excluded.system_prompt,
  is_active = true,
  updated_at = now();

-- ============================================================
-- Routing: telling two law firms apart
-- ============================================================

-- ABR — the disputes vocabulary. A customer in a dispute uses these words and a
-- customer setting up a company does not.
update organizations set routing_keywords = $kw$
  {lawyer,lawyers,advocate,advocates,legal,"legal consultant",court,case,
   litigation,arbitration,dispute,sue,suing,lawsuit,claim,appeal,appeals,cassation,
   criminal,"criminal case",defence,defense,bail,arrest,arrested,detained,police,
   maritime,admiralty,cargo,shipping,vessel,
   construction,fidic,delay,defects,
   trademark,patent,copyright,"intellectual property",
   banking,"m&a",merger,acquisition,
   محامي,محاماة,محامون,قانوني,محكمة,قضية,دعوى,نزاع,استئناف,تمييز,
   جنائي,جنايات,كفالة,توقيف,اعتقال,تحكيم,بحري,انشاءات,علامة تجارية}
$kw$::text[]
where slug = 'abr';

-- Juris Prime Legal — the transactional vocabulary. The generic terms stay so
-- that a vague legal enquiry ties with ABR and triggers the triage question
-- rather than landing on one firm by accident of ordering.
update organizations set routing_keywords = $kw$
  {lawyer,lawyers,attorney,advocate,legal,"legal advice","legal consultation",court,case,
   "business setup","company formation",freezone,"free zone",mainland,
   "power of attorney",poa,notarise,notarize,"contract drafting",contract,agreement,
   memorandum,moa,partnership,shareholder,
   will,inheritance,succession,
   tenancy,eviction,evict,landlord,"rental dispute",
   محامي,محاماة,قانوني,محكمة,قضية,تأسيس,شركة,رخصة,وكالة,توكيل,عقد,اتفاقية,وصية,ميراث,ايجار,اخلاء}
$kw$::text[]
where slug = 'juris-prime-legal';

-- ------------------------------------------------------------
-- Assert the outcome
-- ------------------------------------------------------------
do $$
declare
  reachable int;
  abr_keywords int;
  atif_visible int;
begin
  -- SEEDED DATA IS NOT PART OF THE SCHEMA, and this block asserts the shape of
  -- rows the seed creates. On an empty database there are none, so the check
  -- reported a catastrophe -- and `npm run migrate` against a fresh database
  -- could not get past it. See migration 010 for the full account.
  if not exists (select 1 from organizations) then
    raise notice 'No organizations yet -- skipping this data check on a fresh database.';
    return;
  end if;

  select count(*) into reachable
    from organizations
   where is_active and accepts_shared_number
     and coalesce(array_length(routing_keywords, 1), 0) > 0
     and whatsapp_phone_number_id = (select whatsapp_phone_number_id from organizations where slug = 'zipicka');

  if reachable <> 5 then
    raise exception 'Expected 5 businesses on the shared number, found %', reachable;
  end if;

  select coalesce(array_length(routing_keywords, 1), 0) into abr_keywords
    from organizations where slug = 'abr';
  if abr_keywords < 20 then
    raise exception 'ABR has only % routing keywords — it would be unreachable', abr_keywords;
  end if;

  select count(*) into atif_visible
    from organizations
   where slug = 'atif-ali-production' and (is_active or accepts_shared_number);
  if atif_visible > 0 then
    raise exception 'atif-ali-production is still visible to routing';
  end if;

  raise notice 'ABR is live with % routing keywords; Atif Ali Production removed; 5 businesses on the shared number', abr_keywords;
end
$$;
