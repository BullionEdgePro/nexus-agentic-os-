#!/usr/bin/env bash
#
# Nexus Postgres backup — dump, verify, rotate.
#
# The verification step is the point of this script. A dump file that exists is
# not a backup; a dump file that has been restored successfully is. This one
# restores every dump into a throwaway database and asserts the schema and data
# actually came back, so a silently-truncated or corrupt dump fails loudly on
# the night it happens instead of on the night you need it.
#
# Install on the VPS:
#   chmod +x /opt/nexus/scripts/backup-db.sh
#   ( crontab -l 2>/dev/null; echo "15 3 * * * /opt/nexus/scripts/backup-db.sh >> /var/log/nexus-backup.log 2>&1" ) | crontab -
#
# Restore from a backup:
#   gunzip -c /opt/nexus/backups/nexus-YYYYMMDD-HHMMSS.sql.gz \
#     | docker compose -f /opt/nexus/docker-compose.prod.yml exec -T postgres psql -U nexus -d nexus

set -euo pipefail

NEXUS_DIR="${NEXUS_DIR:-/opt/nexus}"
BACKUP_DIR="${BACKUP_DIR:-$NEXUS_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_USER="${DB_USER:-nexus}"
DB_NAME="${DB_NAME:-nexus}"

# Minimum table count we expect to see in a restored dump. Guards against a
# dump that is technically valid but effectively empty.
MIN_TABLES="${MIN_TABLES:-8}"

COMPOSE=(docker compose -f "$NEXUS_DIR/docker-compose.prod.yml")

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }
fail() { log "FAILED: $*"; exit 1; }

timestamp="$(date -u +'%Y%m%d-%H%M%S')"
dump_file="$BACKUP_DIR/nexus-$timestamp.sql.gz"
verify_db="nexus_verify_$timestamp"

mkdir -p "$BACKUP_DIR"

# ---------------------------------------------------------------
# 1. Dump
# ---------------------------------------------------------------
log "Dumping $DB_NAME -> $dump_file"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip > "$dump_file"

[ -s "$dump_file" ] || fail "dump file is empty"
log "Dump written ($(du -h "$dump_file" | cut -f1))"

# ---------------------------------------------------------------
# 2. Verify by restoring into a scratch database
# ---------------------------------------------------------------
# Always drop the scratch database, even if verification blows up partway —
# otherwise a failed run leaves debris that fills the disk over time.
cleanup_verify_db() {
  "${COMPOSE[@]}" exec -T postgres \
    psql -U "$DB_USER" -d postgres -q -c "drop database if exists \"$verify_db\";" >/dev/null 2>&1 || true
}
trap cleanup_verify_db EXIT

log "Restoring into scratch database $verify_db"
"${COMPOSE[@]}" exec -T postgres \
  psql -U "$DB_USER" -d postgres -q -c "create database \"$verify_db\";" >/dev/null

gunzip -c "$dump_file" \
  | "${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$verify_db" -q >/dev/null 2>&1 \
  || fail "restore into $verify_db errored"

table_count="$("${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$verify_db" -tAc \
  "select count(*) from information_schema.tables where table_schema='public';" | tr -d '[:space:]')"

[ "${table_count:-0}" -ge "$MIN_TABLES" ] \
  || fail "restored database has only ${table_count:-0} tables, expected >= $MIN_TABLES"

# A structurally-perfect dump of an empty database would still pass a table
# count, so assert the tenant rows — the one thing that is never legitimately
# zero on this system — actually survived the round trip.
org_count="$("${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$verify_db" -tAc \
  "select count(*) from organizations;" | tr -d '[:space:]')"

[ "${org_count:-0}" -ge 1 ] \
  || fail "restored database contains no organizations — dump is not usable"

log "Verified: $table_count tables, $org_count organizations restored cleanly"

# ---------------------------------------------------------------
# 3. Rotate
# ---------------------------------------------------------------
# Only prunes AFTER a verified-good backup exists, so a run of failures can
# never quietly delete the last known-good copy.
deleted="$(find "$BACKUP_DIR" -name 'nexus-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
log "Rotation: removed $deleted backup(s) older than $RETENTION_DAYS days"

remaining="$(find "$BACKUP_DIR" -name 'nexus-*.sql.gz' | wc -l)"
log "OK — $remaining backup(s) retained in $BACKUP_DIR"
