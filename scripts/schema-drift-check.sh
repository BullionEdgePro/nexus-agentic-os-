#!/usr/bin/env bash
#
# Has every migration on disk actually reached production?
#
#   cd /opt/nexus && ./scripts/schema-drift-check.sh
#
# THIS PROJECT HAS NO MIGRATION LEDGER, deliberately: every file in migrations/
# is written to be idempotent, so the runner applies all of them every time and
# there is nothing to record. That works exactly as long as the runner is what
# applies them — and on this platform it is not. `nexus_app` has no CREATE, so
# migrations are applied BY HAND as the owner, one psql invocation at a time.
# Whether file 049 ever ran is therefore not written down anywhere, and the only
# honest way to answer it is to look at the schema.
#
# So: build the schema the repository describes in a throwaway database, dump
# both, and diff. A migration written and never applied shows up as a missing
# object. Anything changed in production by hand shows up as an extra one.
#
# The probe database is created and dropped inside this script and holds no
# rows — only DDL. It never touches `nexus`.
set -uo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
PROBE="nexus_schema_probe"
OUT="${TMPDIR:-/tmp}/nexus-schema"
mkdir -p "$OUT"

psql_probe() { $COMPOSE exec -T postgres psql -U nexus -d "$PROBE" -v ON_ERROR_STOP=1 -q "$@"; }

echo "Building the schema the repository describes, in $PROBE"
$COMPOSE exec -T postgres psql -U nexus -d postgres -q -c "drop database if exists $PROBE" > /dev/null 2>&1
$COMPOSE exec -T postgres psql -U nexus -d postgres -q -c "create database $PROBE" > "$OUT/create.log" 2>&1
code=$?
if [ "$code" -ne 0 ]; then
  echo "FAIL — could not create the probe database. $OUT/create.log"
  cat "$OUT/create.log"
  exit 1
fi

cleanup() {
  $COMPOSE exec -T postgres psql -U nexus -d postgres -q -c "drop database if exists $PROBE" > /dev/null 2>&1
}
trap cleanup EXIT

psql_probe -f - < packages/db/schema.sql > "$OUT/apply.log" 2>&1
code=$?
if [ "$code" -ne 0 ]; then
  echo "FAIL — schema.sql did not apply to an empty database. $OUT/apply.log"
  tail -20 "$OUT/apply.log"
  exit 1
fi

applied=0
for file in $(ls packages/db/migrations/*.sql | sort); do
  psql_probe -f - < "$file" >> "$OUT/apply.log" 2>&1
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "FAIL — $(basename "$file") did not apply. This is a broken migration, not drift."
    tail -20 "$OUT/apply.log"
    exit 1
  fi
  applied=$((applied + 1))
done
echo "  schema.sql + $applied migrations applied cleanly"

# Normalised so the diff is about objects, not formatting or ordering. Comments,
# blank lines and the dump's own headers carry no schema meaning.
dump() {
  $COMPOSE exec -T postgres pg_dump -U nexus --schema-only --no-owner --no-acl -d "$1" \
    | grep -vE '^--|^$|^SET |^SELECT pg_catalog|^\connect|^..restrict |^..unrestrict ' \
    | sed 's/[[:space:]]*$//'
}

dump nexus      > "$OUT/production.sql"
dump "$PROBE"   > "$OUT/repository.sql"

# Sorted comparison: pg_dump orders by oid, so the same objects created in a
# different ORDER produce different files with identical content. Sorting the
# statement lines removes that and keeps every real difference.
sort "$OUT/production.sql" > "$OUT/production.sorted"
sort "$OUT/repository.sql" > "$OUT/repository.sorted"

if diff -q "$OUT/production.sorted" "$OUT/repository.sorted" > /dev/null; then
  echo
  echo "PASS — production's schema is exactly what the repository describes."
  exit 0
fi

echo
echo "DRIFT. Lines only in the REPOSITORY are migrations that never reached production:"
diff "$OUT/repository.sorted" "$OUT/production.sorted" | grep '^<' | sed 's/^< /  MISSING  /' | head -40
echo
echo "Lines only in PRODUCTION were changed by hand and are in no migration:"
diff "$OUT/repository.sorted" "$OUT/production.sorted" | grep '^>' | sed 's/^> /  EXTRA    /' | head -40
echo
echo "Full dumps in $OUT"
exit 1
