-- ============================================================
-- Migration 007 — Shared-number routing (switchboard)
-- ============================================================
--
-- Lets ONE WhatsApp number serve every business. Inbound conversations are
-- triaged to a tenant, and from then on that tenant's agent, system prompt and
-- GOVERNANCE apply.
--
-- Governance is the reason this is routing rather than one merged agent.
-- `juris-prime-legal` escalates on medium hallucination risk while `zipicka`
-- does not (packages/governance/src/policy.ts). A single shared agent would
-- either apply the law firm's strictness to everyone — making the assistant
-- useless for retail — or drop it, which means an AI making unverifiable legal
-- claims under a law firm's name. Neither is acceptable, so the tenant has to
-- be known before the substantive reply is composed.
--
-- Additive and idempotent. `routed_organization_id IS NULL` means "not yet
-- triaged", which is exactly how every existing conversation already behaves,
-- so this is a no-op until a number is actually shared.

-- Which tenant this conversation is being served AS. Distinct from
-- organization_id, which stays the owner of the phone number and the contact
-- record — re-parenting those would mean moving contacts between tenants and
-- breaking the (organization_id, wa_id) identity that message dedup relies on.
alter table conversations
  add column if not exists routed_organization_id uuid references organizations(id) on delete set null;

alter table conversations
  add column if not exists routed_at timestamptz;

create index if not exists idx_conversations_routed
  on conversations(routed_organization_id)
  where routed_organization_id is not null;

-- Keywords that identify a business during triage. Rules before a model, for
-- the same reason lead scoring is rules-first: this is cheap, debuggable, adds
-- no latency, and misroutes are visible in the data rather than hidden inside
-- a model's judgement.
alter table organizations
  add column if not exists routing_keywords text[] not null default '{}';

-- Whether this tenant can be reached via a shared number at all. A business
-- with its own dedicated number should not also appear in another number's
-- triage menu.
alter table organizations
  add column if not exists accepts_shared_number boolean not null default false;

-- Seed routing vocabulary. English + Arabic, matching the bilingual approach
-- already taken in lead scoring — the tenants are UAE-based and a customer
-- writing in Arabic must be routable.
update organizations set routing_keywords = $kw$
  {shop,shopping,product,products,order,buy,beauty,cosmetics,pet,"pet food",home,delivery,
   منتج,منتجات,طلب,شراء,تسوق,توصيل,مستحضرات}
$kw$::text[], accepts_shared_number = true
where slug = 'zipicka' and routing_keywords = '{}';

update organizations set routing_keywords = $kw$
  {license,licence,"trade license","business setup","company formation",freezone,"free zone",
   mainland,visa,pro services,
   رخصة,ترخيص,تأسيس,شركة,تاشيرة,منطقة حرة}
$kw$::text[], accepts_shared_number = true
where slug = 'juris-prime' and routing_keywords = '{}';

update organizations set routing_keywords = $kw$
  {lawyer,attorney,legal,court,case,lawsuit,litigation,contract,dispute,notary,
   محامي,قانوني,محكمة,قضية,دعوى,عقد,نزاع}
$kw$::text[], accepts_shared_number = true
where slug = 'juris-prime-legal' and routing_keywords = '{}';

update organizations set routing_keywords = $kw$
  {property,properties,rent,rental,villa,apartment,flat,real estate,viewing,landlord,tenant,
   عقار,عقارات,ايجار,شقة,فيلا,معاينة}
$kw$::text[], accepts_shared_number = true
where slug = 'sfs-international' and routing_keywords = '{}';

update organizations set routing_keywords = $kw$
  {video,videos,production,filming,shoot,photography,editing,content,studio,reel,advert,
   فيديو,تصوير,انتاج,مونتاج,اعلان,استوديو}
$kw$::text[], accepts_shared_number = true
where slug = 'atif-ali-production' and routing_keywords = '{}';
