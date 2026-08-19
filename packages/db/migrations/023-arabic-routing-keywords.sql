-- ============================================================
-- 023 — Arabic routing keywords
--
-- The triage menu now answers in Arabic, which fixed the reply and not the
-- routing. Keywords were English-only, so an Arabic enquiry that SHOULD go
-- straight to the law firm matched nothing, fell to triage, and asked the
-- customer a question the keywords could have answered.
--
-- THIS VOCABULARY NEEDS REVIEW BY SOMEONE WHO KNOWS THESE BUSINESSES.
--
-- These are standard Modern Standard Arabic terms, chosen conservatively. But
-- routing decides which GOVERNANCE applies: a term belonging to the law firm
-- and listed under the shop puts a legal question in front of an agent
-- permitted to answer speculatively. No dictionary substitutes for someone who
-- knows what these firms are actually asked.
--
-- WHY EACH WORD APPEARS SEVERAL TIMES.
--
-- Arabic attaches its article and possessives directly to the word: طلب
-- (order), الطلب (the order), طلبي (my order) are three different strings, and
-- matching is whole-word. `normalizeForMatch` already folds orthographic
-- variation — tashkeel, hamza carriers, taa marbuta, alef maqsura — but it does
-- not and should not strip affixes, because ال is also the start of ordinary
-- words and removing it would introduce false matches into the mechanism that
-- selects a governance policy.
--
-- So inflections are listed explicitly. That is this codebase's existing rule
-- for English plurals (see toWordBag) and it matters far more here: a customer
-- writing "أين طلبي؟" — where is my order — matched nothing at all before these
-- were added. Caught by a test using that exact sentence.
--
-- Deliberately omitted, because they are genuinely ambiguous and asking is the
-- right answer:
--   استشارة (consultation) — every business here gives them
--   عقد     (contract)     — the shop and both law firms
--   خدمة    (service)      — everyone
-- Listing those would make the ambiguity silent instead of asked.
--
-- Appended, never replaced: the English keywords stay, and re-running adds
-- nothing new.
-- ============================================================

update organizations set routing_keywords = array(
  select distinct unnest(routing_keywords || array[
    'محامي', 'المحامي', 'محاماة', 'محام',
    'قضية', 'القضية', 'قضيتي',
    'محكمة', 'المحكمة',
    'دعوى', 'الدعوى',
    'تحكيم', 'التحكيم',
    'جنائي', 'الجنائي',
    'كفالة', 'الكفالة',
    'استئناف', 'الاستئناف',
    'نقض', 'النقض', 'مرافعة'
  ])
) where slug = 'abr' and is_active;

update organizations set routing_keywords = array(
  select distinct unnest(routing_keywords || array[
    'تصديق', 'التصديق', 'تصديقات', 'التصديقات',
    'توثيق', 'التوثيق',
    'سفارة', 'السفارة',
    'ترجمة معتمدة', 'الترجمة المعتمدة',
    'شهادة تخرج', 'شهادتي',
    'وزارة الخارجية'
  ])
) where slug = 'juris-prime' and is_active;

update organizations set routing_keywords = array(
  select distinct unnest(routing_keywords || array[
    'تأسيس شركة', 'تأسيس',
    'رخصة تجارية', 'الرخصة التجارية', 'رخصة',
    'منطقة حرة', 'المنطقة الحرة',
    'وكالة قانونية', 'الوكالة',
    'وصية', 'الوصية',
    'إخلاء', 'الإخلاء',
    'عقد إيجار'
  ])
) where slug = 'juris-prime-legal' and is_active;

update organizations set routing_keywords = array(
  select distinct unnest(routing_keywords || array[
    'عقار', 'العقار', 'عقارات', 'العقارات',
    'شقة', 'الشقة',
    'فيلا', 'الفيلا',
    'تملك', 'التملك',
    'استثمار عقاري'
  ])
) where slug = 'sfs-international' and is_active;

update organizations set routing_keywords = array(
  select distinct unnest(routing_keywords || array[
    'طلب', 'الطلب', 'طلبي', 'طلبية', 'طلبيتي',
    'توصيل', 'التوصيل',
    'شحن', 'الشحن', 'شحنتي',
    'منتج', 'المنتج', 'منتجات',
    'إرجاع', 'الإرجاع', 'استبدال'
  ])
) where slug = 'zipicka' and is_active;

-- Report every keyword now claimed by more than one business.
--
-- Not an error. A doubly-claimed word makes the switchboard ask rather than
-- guess, which is safe and sometimes correct — "إيجار" genuinely could be a
-- rental enquiry or an eviction case. What matters is that it is visible here
-- rather than discovered from a customer who was asked a question the system
-- should have answered.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select lower(keyword) as keyword, array_agg(o.slug order by o.slug) as claimants
      from organizations o, unnest(o.routing_keywords) as keyword
     where o.is_active
     group by lower(keyword)
    having count(distinct o.slug) > 1
     order by 1
  loop
    n := n + 1;
    raise notice 'shared keyword "%" — claimed by %', r.keyword, array_to_string(r.claimants, ', ');
  end loop;

  if n = 0 then
    raise notice 'No keyword is claimed by two businesses.';
  else
    raise notice '% shared keyword(s). Each routes to NEITHER business — the switchboard asks instead.', n;
  end if;
end $$;

do $$
declare
  arabic integer;
begin
  -- SEEDED DATA IS NOT PART OF THE SCHEMA, and this block asserts the shape of
  -- rows the seed creates. On an empty database there are none, so the check
  -- reported a catastrophe -- and `npm run migrate` against a fresh database
  -- could not get past it. See migration 010 for the full account.
  if not exists (select 1 from organizations) then
    raise notice 'No organizations yet -- skipping this data check on a fresh database.';
    return;
  end if;

  select count(*) into arabic
    from organizations o, unnest(o.routing_keywords) as keyword
   where o.is_active and keyword ~ '[؀-ۿ]';
  raise notice 'Arabic keywords now in routing: %', arabic;
  -- "No error" is not evidence. A migration whose updates matched nothing and
  -- reported success is this codebase's signature failure.
  if arabic = 0 then
    raise exception 'No Arabic keywords were stored — the updates matched no rows.';
  end if;
end $$;
