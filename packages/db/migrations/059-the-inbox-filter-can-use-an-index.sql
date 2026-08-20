-- The inbox's own filter defeats every index on the table.
--
-- Since migration 054 the inbox, and every per-business read of a conversation,
-- filters on an EXPRESSION:
--
--     where coalesce(c.routed_organization_id, c.organization_id) = $1
--
-- Postgres cannot use `idx_conversations_org_status` or
-- `idx_conversations_routed` for that, because neither indexes the coalesce.
-- The result is a sequential scan of the whole conversations table on the most
-- opened screen in the product.
--
-- IT IS INVISIBLE TODAY AND WILL STAY INVISIBLE UNTIL IT IS NOT. Production
-- holds fifteen conversations, and at that size Postgres would ignore an index
-- even if one existed -- so "the inbox is fast" is currently a statement about
-- having no customers. Measured in a throwaway database seeded with 2,000
-- conversations and 24,000 messages, which is a modest month once the deep
-- links are published:
--
--     inbox, serving business    0.215 ms    SEQ SCAN
--
-- Fast, and scanning everything. The cost is linear in conversations, so it is
-- the shape of the plan that matters here rather than the number of
-- milliseconds.
--
-- An expression index on exactly the expression the query uses fixes it. The
-- coalesce must match character for character or the planner will not use it,
-- which is why this file and packages/db/src/conversations.ts have to agree --
-- see the test that pins them together.

create index if not exists idx_conversations_serving
  on conversations ((coalesce(routed_organization_id, organization_id)), opened_at desc);

-- The same expression appears in the operators that resolve a conversation's
-- serving business, and in the search page's lateral lookup. One index serves
-- all of them because they all spell it the same way.

do $$
declare
  indexed boolean;
begin
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'conversations'
       and indexname = 'idx_conversations_serving'
  ) into indexed;

  if not indexed then
    raise exception 'idx_conversations_serving was not created';
  end if;

  -- Deliberately NOT a probe of whether the planner uses it. On fifteen rows it
  -- will not, correctly, and a migration asserting otherwise would fail on
  -- production while being right about the code. The plan is measured by
  -- scripts/load-probe.sh against a seeded database, which is where a question
  -- about scale can actually be answered.
  raise notice 'The inbox filter now has an index it can use, once there is enough data to want one.';
end $$;
