#!/usr/bin/env bash
#
# Nexus Postgres backup — dump, verify, send off-box, rotate.
#
# The verification step is the point of this script. A dump file that exists is
# not a backup; a dump file that has been restored successfully is. This one
# restores every dump into a throwaway database and asserts the schema and data
# actually came back, so a silently-truncated or corrupt dump fails loudly on
# the night it happens instead of on the night you need it.
#
# The off-box step applies the same rule one level up: a copy that lives on the
# disk it is protecting is not off-box, and an upload that exited 0 is not a
# copy until it has been read back. It is inert until BACKUP_REMOTE is set, and
# says so on every run rather than letting silence pass for safety.
#
# Restoring an off-box copy:
#   gpg --batch --quiet --decrypt --passphrase "$BACKUP_PASSPHRASE" \
#       nexus-YYYYMMDD-HHMMSS.sql.gz.gpg > nexus.sql.gz
#   ...then the same restore line as below.
#
# Install on the VPS:
#   chmod +x /opt/nexus/scripts/backup-db.sh
#   ( crontab -l 2>/dev/null; echo "15 3 * * * /opt/nexus/scripts/backup-db.sh >> /var/log/nexus-backup.log 2>&1" ) | crontab -
#
# Restore from a backup:
#   gunzip -c /opt/nexus/backups/nexus-YYYYMMDD-HHMMSS.sql.gz \
#     | docker compose -f /opt/nexus/docker-compose.prod.yml exec -T postgres psql -U nexus -d nexus

set -euo pipefail

# Secrets come from a root-only file, not from the crontab.
#
# The obvious way to pass BACKUP_PASSPHRASE to a cron job is to put it on the
# cron line. That writes the key to your customers' conversations into a file
# listed by `crontab -l`, backed up by every root-level tool on the box, and
# shoulder-surfable in any terminal someone is helping you in. This is read
# first so the crontab stays exactly as it is — one path, no secrets.
#
# Absent, nothing happens and the script behaves as it always has. Sourced
# rather than parsed so it can hold shell quoting for a passphrase with spaces.
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/nexus-backup.env}"
# shellcheck source=/dev/null
[ -r "$BACKUP_ENV_FILE" ] && . "$BACKUP_ENV_FILE"

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
# 0. Is there room to do this at all?
# ---------------------------------------------------------------
#
# A backup that fills the disk takes down the database it is protecting, and it
# does it at 03:15 while nobody is watching. Postgres, the dumps, the Docker
# build cache and the images all live on one 96GB volume on this box, and the
# build cache alone grew ten gigabytes in a single day of deploys — reclaimable,
# but nothing reclaims it on a schedule.
#
# So this refuses BEFORE writing rather than failing part-way through. A dump
# that runs out of space mid-write leaves a truncated file that the verify step
# below would correctly reject — but only after the disk is already full, which
# is the state that matters and the one nothing else would report.
#
# Refusing loses one night's backup. Proceeding can lose the database. The
# threshold is generous on purpose: at 2GB free there is still room to log, to
# rotate, and for somebody to run `docker builder prune` before anything breaks.
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
free_mb="$(df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [ -z "$free_mb" ]; then
  # Not fatal: an unreadable df is not evidence of a full disk, and refusing to
  # back up on the strength of a parsing failure would be the same mistake in
  # the other direction.
  log "WARNING: could not read free space for $BACKUP_DIR — proceeding"
elif [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
  fail "only ${free_mb}MB free on $BACKUP_DIR, need ${MIN_FREE_MB}MB. Refusing to dump: filling this disk stops Postgres. Try: docker builder prune -f"
else
  log "Free space ${free_mb}MB (floor ${MIN_FREE_MB}MB)"
fi

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
# 3. Off-box copy
# ---------------------------------------------------------------
#
# THE GAP THIS CLOSES, AND THE ONE IT CANNOT. Everything above proves the dump
# restores. All of it lands in /opt/nexus/backups, on the same disk as the
# database it is protecting. That covers the failure people actually hit —
# somebody drops a table, a migration goes wrong — and covers nothing at all if
# the disk or the VPS goes. There are no Hostinger snapshots on this box.
#
# Placed AFTER verification on purpose: the only dump worth sending anywhere is
# one that has just been proved to restore. Uploading first would fill a bucket
# with files carrying the same unknown as the local ones.
#
# ENCRYPTION IS NOT OPTIONAL WHEN A REMOTE IS SET. These dumps contain real
# customers' WhatsApp conversations — names, numbers, what they asked a law firm
# about. Putting that in a third-party bucket in the clear is a decision nobody
# made deliberately, so this refuses rather than making it quietly. gpg is
# already on the box; symmetric is enough here and needs no key distribution.
#
# Configure with:
#   BACKUP_REMOTE=b2:nexus-backups      # any rclone remote:path
#   BACKUP_PASSPHRASE=<long secret>     # kept OFF this machine as well
#
# Unset, this step does nothing but say so — every single run, and again in the
# final line. A backup script that stays silent about not being off-box is the
# same shape as the dump that was never restored: fine until it is not.
if [ -z "${BACKUP_REMOTE:-}" ]; then
  offsite="NOT off-box — local disk only"
  log "Off-box copy: SKIPPED. BACKUP_REMOTE is not set, so this dump exists only on"
  log "              this machine, beside the database it is protecting. Losing the"
  log "              disk loses both. See the header for the two values needed."
else
  command -v rclone >/dev/null \
    || fail "BACKUP_REMOTE is set but rclone is not installed — install it (curl https://rclone.org/install.sh | sudo bash) and configure the remote, or unset BACKUP_REMOTE"

  [ -n "${BACKUP_PASSPHRASE:-}" ] \
    || fail "BACKUP_REMOTE is set but BACKUP_PASSPHRASE is not — refusing to upload customer conversations unencrypted"

  encrypted="$dump_file.gpg"
  # --batch/--yes so it never waits on a tty inside cron, which would hang the
  # run rather than fail it.
  printf '%s' "$BACKUP_PASSPHRASE" \
    | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
          --passphrase-fd 0 --output "$encrypted" "$dump_file" \
    || fail "encryption failed — nothing uploaded"

  log "Uploading $(basename "$encrypted") ($(du -h "$encrypted" | cut -f1)) to $BACKUP_REMOTE"
  rclone copy "$encrypted" "$BACKUP_REMOTE" --no-traverse \
    || fail "upload to $BACKUP_REMOTE failed"

  # READ IT BACK. "rclone copy exited 0" is the same class of evidence as "the
  # dump file exists" — this script exists because that was not good enough.
  local_size="$(stat -c%s "$encrypted")"
  remote_size="$(rclone size "$BACKUP_REMOTE/$(basename "$encrypted")" --json 2>/dev/null \
    | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"

  [ -n "$remote_size" ] \
    || fail "uploaded to $BACKUP_REMOTE but could not read the object back — treat this as no off-box copy"
  [ "$remote_size" = "$local_size" ] \
    || fail "off-box copy is $remote_size bytes, local is $local_size — truncated upload"

  rm -f "$encrypted"
  offsite="off-box, encrypted, $remote_size bytes verified"
  log "Off-box copy verified: $remote_size bytes at $BACKUP_REMOTE"
fi

# ---------------------------------------------------------------
# 4. Rotate
# ---------------------------------------------------------------
# Only prunes AFTER a verified-good backup exists, so a run of failures can
# never quietly delete the last known-good copy.
deleted="$(find "$BACKUP_DIR" -name 'nexus-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
log "Rotation: removed $deleted backup(s) older than $RETENTION_DAYS days"

remaining="$(find "$BACKUP_DIR" -name 'nexus-*.sql.gz' | wc -l)"
# The summary line carries the off-box state, because it is the line a person
# actually skims in a log they are not reading closely. "OK" on its own would
# read as fully protected on the day it is anything but.
log "OK — $remaining backup(s) retained in $BACKUP_DIR; latest is $offsite"
