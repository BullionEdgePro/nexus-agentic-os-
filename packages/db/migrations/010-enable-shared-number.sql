-- ============================================================
-- Migration 010 — Put every business on the one WhatsApp number
-- ============================================================
--
-- Migrations 007–009 built the switchboard and left it inert: routing only
-- engages when two or more active tenants advertise the same
-- `whatsapp_phone_number_id`, and only Zipicka had one. This turns it on.
--
-- This is a real behaviour change for the tenant already serving customers.
-- A message that today gets a Zipicka welcome will, if it carries no routing
-- signal ("hi"), instead get "which of these is your enquiry about?". Messages
-- that DO carry signal ("do you have this in stock?") still go straight to
-- Zipicka — classification runs first and only falls back to the menu when it
-- genuinely cannot tell.
--
-- Reversible: restore each tenant's own (or empty) phone number id and the
-- switchboard goes back to sleep, because "is this number shared?" is derived
-- from the data rather than stored as a flag that can drift out of sync.

-- ------------------------------------------------------------
-- The uniqueness that made sharing impossible
-- ------------------------------------------------------------
--
-- `organizations.whatsapp_phone_number_id` carried a UNIQUE constraint from the
-- original schema, where one number belonged to exactly one tenant. That was a
-- correct thing to assert at the time and it is the whole premise this
-- migration overturns, so it has to go first — the update below fails on it
-- otherwise, which is exactly what happened on the first attempt.
--
-- What the constraint was really protecting was `findOrganizationByPhoneNumberId`
-- returning exactly one row. That guarantee has already been replaced by
-- something better suited to a shared number: an explicit `is_number_owner`
-- flag and a deterministic ORDER BY (migration 009). Dropping it removes a
-- guard whose job is already done, not a guard with nothing behind it.
--
-- Written to find the constraint rather than name it, because a database
-- created from schema.sql and one grown through migrations can name the same
-- constraint differently, and a hardcoded name that silently matches nothing
-- would leave the failure to be discovered by the UPDATE.
do $$
declare
  constraint_name text;
  index_name text;
begin
  select con.conname into constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_attribute att on att.attrelid = rel.oid and att.attnum = any(con.conkey)
   where rel.relname = 'organizations'
     and con.contype = 'u'
     and att.attname = 'whatsapp_phone_number_id'
     and array_length(con.conkey, 1) = 1
   limit 1;

  if constraint_name is not null then
    execute format('alter table organizations drop constraint %I', constraint_name);
    raise notice 'Dropped unique constraint % on whatsapp_phone_number_id', constraint_name;
  end if;

  -- A bare unique INDEX (no constraint) enforces the same thing and would be
  -- missed by the query above.
  select cls.relname into index_name
    from pg_index idx
    join pg_class cls on cls.oid = idx.indexrelid
    join pg_class tbl on tbl.oid = idx.indrelid
    join pg_attribute att on att.attrelid = tbl.oid and att.attnum = any(idx.indkey)
   where tbl.relname = 'organizations'
     and idx.indisunique
     and not idx.indisprimary
     and att.attname = 'whatsapp_phone_number_id'
     and idx.indnatts = 1
   limit 1;

  if index_name is not null then
    execute format('drop index %I', index_name);
    raise notice 'Dropped unique index % on whatsapp_phone_number_id', index_name;
  end if;
end
$$;

-- Lookup by number happens on every inbound webhook, so the column still needs
-- an index — just not a unique one.
create index if not exists idx_organizations_phone_number_id
  on organizations (whatsapp_phone_number_id)
  where whatsapp_phone_number_id is not null;

-- ------------------------------------------------------------
-- Guard: refuse to run if the source number is not there
-- ------------------------------------------------------------
--
-- Without this, a missing or blank Zipicka number would quietly copy an empty
-- string onto all five tenants, `findOrganizationByPhoneNumberId` would match
-- on '' for any webhook, and every business would appear to share a number that
-- does not exist. That is the failure mode this codebase keeps producing: not
-- an error, just a plausible-looking wrong state. Fail loudly instead.
do $$
declare
  src_phone text;
  src_waba  text;
begin
  select whatsapp_phone_number_id, whatsapp_business_account_id
    into src_phone, src_waba
    from organizations
   where slug = 'zipicka' and is_active = true;

  -- NOTHING TO SHARE IS NOT THE SAME AS A BLANK NUMBER, and this guard could
  -- not tell them apart. On an empty database there is no zipicka row at all,
  -- so `select into` leaves src_phone null and the raise below fired -- which
  -- means `npm run migrate` against a fresh database has always failed here,
  -- at file 010 of 51. The documented fresh-install path could not complete,
  -- and nobody found out because nobody has installed this from scratch since
  -- the seed and the migrations diverged. Found 2026-08-19 by building the
  -- repository's own schema in a throwaway database.
  --
  -- A database with no organizations has no number to copy and no tenants to
  -- copy it to, so this file has genuinely nothing to do. Seeding happens
  -- afterwards and creates the businesses already sharing the number.
  if not found then
    raise notice 'No zipicka row -- fresh database, nothing to share. Skipping.';
    return;
  end if;

  if src_phone is null or src_phone = '' then
    raise exception
      'Cannot share the number: zipicka has no whatsapp_phone_number_id. Set it before running migration 010.';
  end if;

  -- ------------------------------------------------------------
  -- Point every other business at it
  -- ------------------------------------------------------------
  --
  -- atif-ali-production is included because the operator asked for every
  -- business on the number. Worth knowing what that means: its website is
  -- offline, so it has no knowledge base, and an agent routed there can only
  -- answer from its system prompt — no citable facts about services or prices.
  -- It will route and reply; it just cannot look anything up yet.
  update organizations
     set whatsapp_phone_number_id     = src_phone,
         whatsapp_business_account_id = src_waba,
         accepts_shared_number        = true,
         -- Zipicka stays the owner. Without this the migration-009 backfill,
         -- which marked each sole holder of a number as its owner, would leave
         -- five owners on one number and `findOrganizationByPhoneNumberId`
         -- would go back to being order-dependent — the exact bug 009 fixed.
         is_number_owner              = false
   where slug in ('juris-prime', 'juris-prime-legal', 'sfs-international', 'atif-ali-production')
     and is_active = true;

  update organizations
     set accepts_shared_number = true,
         is_number_owner       = true
   where slug = 'zipicka';
end
$$;

-- ------------------------------------------------------------
-- Assert the intended state actually exists
-- ------------------------------------------------------------
--
-- Not "did anything error" — this asserts the number of tenants genuinely
-- reachable on the shared number, using the same predicate the runtime query
-- uses (active, accepts_shared_number, and at least one routing keyword).
-- A tenant with no keywords can never win classification, so it would be
-- invisible to routing while looking correctly configured in the table.
do $$
declare
  reachable int;
  shared_no text;
begin
  select whatsapp_phone_number_id into shared_no
    from organizations where slug = 'zipicka';

  -- Same distinction as the guard above: on a fresh database there is nothing
  -- to verify, and asserting "5 of 5 reachable" against an empty table reports
  -- 0 and reads as a catastrophe. The businesses arrive with the seed, which
  -- runs after this file.
  if not found then
    raise notice 'No organizations yet -- nothing to verify. Skipping.';
    return;
  end if;

  select count(*) into reachable
    from organizations
   where whatsapp_phone_number_id = shared_no
     and is_active = true
     and accepts_shared_number = true
     and coalesce(array_length(routing_keywords, 1), 0) > 0;

  if reachable < 5 then
    raise exception
      'Shared number reaches only % of 5 businesses — check is_active, accepts_shared_number and routing_keywords', reachable;
  end if;

  raise notice 'Switchboard live: % businesses reachable on the shared number', reachable;
end
$$;
