#!/usr/bin/env bash
#
# What falls over first when the tap opens?
#
# The platform has handled 39 inbound messages and is built for thousands. Every
# query on the hot path has only ever been planned against a table small enough
# that Postgres ignores indexes entirely, so "it is fast" today means nothing.
#
# This builds the schema in a THROWAWAY database, seeds a realistic load, and
# runs EXPLAIN ANALYZE over the queries that matter. It never touches `nexus`.
set -uo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
PROBE="nexus_load_probe"
psql_probe() { $COMPOSE exec -T postgres psql -U nexus -d "$PROBE" -v ON_ERROR_STOP=1 -q "$@"; }

echo "Building $PROBE"
$COMPOSE exec -T postgres psql -U nexus -d postgres -q -c "drop database if exists $PROBE" >/dev/null 2>&1
$COMPOSE exec -T postgres psql -U nexus -d postgres -q -c "create database $PROBE" >/dev/null 2>&1
trap '$COMPOSE exec -T postgres psql -U nexus -d postgres -q -c "drop database if exists '"$PROBE"'" >/dev/null 2>&1' EXIT

psql_probe -f - < packages/db/schema.sql > /tmp/load-apply.log 2>&1 || { echo "schema failed"; tail -5 /tmp/load-apply.log; exit 1; }
for f in $(ls packages/db/migrations/*.sql | sort); do
  psql_probe -f - < "$f" >> /tmp/load-apply.log 2>&1 || { echo "migration $(basename $f) failed"; tail -5 /tmp/load-apply.log; exit 1; }
done
echo "  schema + migrations applied"

echo "Seeding"
psql_probe -f - <<'SQL' > /tmp/load-seed.log 2>&1
-- Five businesses on one number, the shape production actually has.
insert into organizations (name, slug, whatsapp_phone_number_id, whatsapp_business_account_id, is_active, accepts_shared_number, routing_keywords, is_number_owner)
select 'Firm ' || i, 'firm-' || i, '999', 'waba', true, true, array['kw' || i], (i = 1)
  from generate_series(1, 5) i;

insert into contacts (organization_id, wa_id, display_name)
select (select id from organizations where slug = 'firm-1'),
       '9715' || lpad(i::text, 8, '0'),
       'Customer ' || i
  from generate_series(1, 2000) i;

-- 2000 conversations, 80% routed away from the owner, as a shared number does.
insert into conversations (organization_id, contact_id, status, routed_organization_id)
select (select id from organizations where slug = 'firm-1'),
       ct.id,
       'open',
       case when random() < 0.8
            then (select id from organizations where slug = 'firm-' || (2 + floor(random() * 4)::int))
            else null end
  from contacts ct;

-- ~12 messages per conversation.
insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, status, created_at)
select c.organization_id, c.id, c.contact_id,
       case when g % 2 = 0 then 'inbound' else 'outbound' end,
       case when g % 2 = 0 then 'contact' else 'ai_agent' end,
       'message body ' || g,
       'delivered',
       now() - (g || ' hours')::interval
  from conversations c, generate_series(1, 12) g;

insert into conversation_metrics (organization_id, conversation_id, intent, resolved_by, input_tokens, output_tokens, reply_outcome)
select c.organization_id, c.id, 'general_inquiry', 'ai_agent', 100, 80, 'agent' from conversations c;

analyze;
SQL
if [ $? -ne 0 ]; then echo "seed failed"; tail -8 /tmp/load-seed.log; exit 1; fi

psql_probe -c "select 'seeded: ' || (select count(*) from conversations) || ' conversations, ' || (select count(*) from messages) || ' messages, ' || (select count(*) from contacts) || ' contacts'" 2>/dev/null | head -3

echo
echo "Hot-path plans (looking for Seq Scan on a big table)"
echo "-------------------------------------------------------"

run() {
  local label="$1"; shift
  local out
  out=$(psql_probe -c "explain (analyze, buffers, costs off) $1" 2>&1)
  local ms
  ms=$(printf '%s' "$out" | grep -oE 'Execution Time: [0-9.]+' | grep -oE '[0-9.]+')
  local scans
  scans=$(printf '%s' "$out" | grep -cE 'Seq Scan on (messages|conversations|contacts|conversation_metrics)')
  printf '  %-42s %8s ms   %s\n' "$label" "${ms:-?}" \
    "$([ "${scans:-0}" -gt 0 ] && echo "SEQ SCAN x$scans" || echo "indexed")"
}

OWNER=$(psql_probe -tAc "select id from organizations where slug='firm-1'" 2>/dev/null | tr -d '\r')
SERVING=$(psql_probe -tAc "select id from organizations where slug='firm-3'" 2>/dev/null | tr -d '\r')

run "inbox, serving business" \
  "select c.id from conversations c join contacts ct on ct.id=c.contact_id where coalesce(c.routed_organization_id, c.organization_id) = '$SERVING' order by c.opened_at desc limit 50"

run "customer-waiting operator" \
  "select c.id from conversations c join contacts ct on ct.id=c.contact_id join lateral (select sender_type, created_at from messages m where m.conversation_id=c.id order by m.created_at desc limit 1) last on true where c.organization_id='$OWNER' and c.status in ('open','pending') and last.sender_type='contact'"

run "delivery-failing operator" \
  "select count(*) from messages where serving_organization_id='$SERVING' and direction='outbound' and created_at > now() - interval '24 hours'"

run "quality rollup, one day" \
  "select count(*) from messages m where m.serving_organization_id='$SERVING' and m.created_at >= now() - interval '1 day'"

run "header search by name" \
  "select ct.id from contacts ct where '$SERVING'::uuid = any (ct.served_organization_ids) and lower(coalesce(ct.display_name,'')) like '%customer 1%' limit 8"

run "agent-unavailable operator" \
  "select count(*) from conversation_metrics where serving_organization_id='$SERVING' and recorded_at > now() - interval '24 hours'"
