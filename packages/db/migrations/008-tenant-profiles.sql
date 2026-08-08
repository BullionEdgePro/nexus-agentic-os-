-- ============================================================
-- Migration 008 — Tenant profiles + corrected routing
-- ============================================================
--
-- Gives every tenant an identity the UI and the agents can use: website, logo,
-- tagline and a factual summary. Also CORRECTS the routing keywords seeded in
-- migration 007, which were written from the tenant names before anyone had
-- looked at the actual businesses.
--
-- The correction matters. `juris-prime` is truecopyattestions.com — document
-- attestation, notary and legal translation — not business licensing, which is
-- what 007 assumed from the name. Meanwhile business setup is advertised on the
-- LEGAL site. Routing on the guessed keywords would have sent attestation
-- enquiries to a litigation agent and company-formation enquiries to an
-- attestation agent: confidently wrong, and invisible without checking.
--
-- Additive and idempotent.

alter table organizations add column if not exists website_url text;
alter table organizations add column if not exists logo_url    text;
alter table organizations add column if not exists tagline     text;
alter table organizations add column if not exists summary     text;
-- Some tenants have no live site. Recorded explicitly so "no website" is a
-- known fact rather than an empty column someone later mistakes for missing data.
alter table organizations add column if not exists website_status text
  check (website_status is null or website_status in ('live', 'offline', 'none'));

-- ---------- Zipicka ----------
update organizations set
  website_url = 'https://zipicka.com',
  logo_url = 'https://zipicka.com/cdn/shop/files/zipicka-logo-header.png',
  website_status = 'live',
  tagline = 'Beauty, pet supplies & home essentials — Dubai, UAE',
  summary = 'E-commerce store on Shopify selling authentic beauty and skincare, pet food and supplies, and home essentials across the UAE. Free delivery on orders over Dhs. 50, 30-day return policy, delivers to all seven emirates. The only tenant with a live WhatsApp number and an indexed knowledge base.'
where slug = 'zipicka';

-- ---------- Juris Prime (True Copy Attestation) ----------
update organizations set
  website_url = 'https://truecopyattestions.com',
  logo_url = 'https://truecopyattestions.com/wp-content/uploads/2020/09/TRUE-COPY-final-300x300.png',
  website_status = 'live',
  tagline = 'Document attestation & notary services — Dubai',
  summary = 'Document attestation and certification services in Dubai: true copy attestation, certificate and document attestation, notary services and legal translation. NOT business licensing — that assumption in migration 007 was wrong and is corrected here.'
where slug = 'juris-prime';

-- ---------- Juris Prime Legal ----------
update organizations set
  website_url = 'https://jurisprimelegal.ae',
  logo_url = 'https://jurisprimelegal.ae/wp-content/uploads/2024/12/cropped-images-4-150x150.png-180x180.webp',
  website_status = 'live',
  tagline = 'Legal services & business setup — Dubai',
  summary = 'Law firm offering legal consultation, representation and business setup support in Dubai. Held to the STRICTEST governance on the platform: escalates to a human on medium hallucination risk, may not give specific legal advice, predict outcomes, or cite law from memory.'
where slug = 'juris-prime-legal';

-- ---------- SFS International ----------
update organizations set
  website_url = 'https://sfsintrealestate.com',
  logo_url = 'https://sfsintrealestate.com/wp-content/uploads/2024/01/SFS-International-Real-Estate-LLC-4.png',
  website_status = 'live',
  tagline = 'Real estate — sales, rentals & property management, UAE',
  summary = 'Real estate agency (SFS International Real Estate LLC) handling property sales, rentals and viewings in the UAE. Site runs the Houzez property theme with searchable listings.'
where slug = 'sfs-international';

-- ---------- Atif Ali Production ----------
update organizations set
  website_url = 'http://www.atifaliproduction.ae',
  logo_url = null,
  -- Verified unreachable 2026-08-03 (connection failure, not a 404). Recorded
  -- as offline so the knowledge re-indexer does not repeatedly retry a dead
  -- host and mark the source failed every cycle.
  website_status = 'offline',
  tagline = 'Digital media production studio — UAE',
  summary = 'Digital media production studio: video production, filming, editing and content for brands. Website is currently OFFLINE (domain unreachable), so no knowledge base can be built from it until the site is restored or content is supplied another way.'
where slug = 'atif-ali-production';

-- ============================================================
-- Routing keywords, corrected against the real businesses
-- ============================================================

update organizations set routing_keywords = $kw$
  {attestation,attest,"true copy","document attestation","certificate attestation",notary,
   notarisation,notarization,"legal translation",translation,mofa,embassy,apostille,stamp,
   تصديق,توثيق,كاتب عدل,ترجمة,ترجمه,سفارة,شهادة}
$kw$::text[]
where slug = 'juris-prime';

update organizations set routing_keywords = $kw$
  {lawyer,lawyers,attorney,legal,"legal advice","legal consultation",court,case,lawsuit,
   litigation,dispute,"business setup","company formation",freezone,"free zone",mainland,
   محامي,محاماة,قانوني,محكمة,قضية,دعوى,نزاع,تأسيس,شركة}
$kw$::text[]
where slug = 'juris-prime-legal';

-- Zipicka: plurals listed explicitly, because routing matches whole words and
-- "production" must never match the retail keyword "product".
update organizations set routing_keywords = $kw$
  {shop,shopping,product,products,order,orders,buy,purchase,beauty,skincare,cosmetics,
   pet,pets,"pet food",home,essentials,delivery,stock,
   منتج,منتجات,طلب,شراء,تسوق,توصيل,مستحضرات,عناية}
$kw$::text[]
where slug = 'zipicka';

update organizations set routing_keywords = $kw$
  {property,properties,rent,rental,buy a villa,villa,apartment,flat,studio flat,"real estate",
   viewing,landlord,tenant,listing,listings,mortgage,
   عقار,عقارات,ايجار,إيجار,شقة,فيلا,معاينة,تملك}
$kw$::text[]
where slug = 'sfs-international';

update organizations set routing_keywords = $kw$
  {video,videos,production,filming,shoot,shooting,photography,photographer,editing,montage,
   content,studio,reel,reels,advert,advertisement,commercial,
   فيديو,تصوير,انتاج,إنتاج,مونتاج,اعلان,إعلان,استوديو}
$kw$::text[]
where slug = 'atif-ali-production';
