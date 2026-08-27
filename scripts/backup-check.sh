#!/usr/bin/env bash
#
# Is the last line of defence still standing?
#
#   cd /opt/nexus && ./scripts/backup-check.sh
#
# ============================================================
# WHY THIS EXISTS
# ============================================================
#
# `backup-db.sh` is good. It dumps, RESTORES THE DUMP INTO A SCRATCH DATABASE,
# asserts the tables and rows came back, rotates, and says out loud that the copy
# is not off-box. It has run every night at 03:15 and this morning's verified 32
# tables and 6 organizations.
#
# And nothing reads any of that. The cron line appends to
# /var/log/nexus-backup.log and no script, gate, operator or health endpoint has
# ever opened it. On 2026-08-24 a grep across the whole repository for that path
# returned the backup script itself and nothing else.
#
# So the failure mode is the quiet one. The container stops, the disk fills, the
# postgres service is renamed, the dump starts coming out truncated — and the
# symptom is a log line nobody reads, in a file that grows, on a machine where
# everything else is green. The first person to discover it is whoever needs the
# backup, which is the worst possible moment and the one time it cannot be fixed.
#
# ============================================================
# WHAT IT CHECKS, AND WHAT THAT IS WORTH
# ============================================================
#
# Four things, and the third is the one that matters:
#
#   1. A dump exists at all.
#   2. The newest one is recent enough to be last night's.
#   3. THAT DUMP WAS RESTORE-VERIFIED — the log records a Verified line after
#      the Dumping line naming this exact file. A dump nobody has restored is a
#      file, and a check that only looked for the file would pass on a
#      well-formed 20-byte truncation.
#   4. Its size is in the same country as the recent ones, which is what catches
#      a dump that ran, verified an empty schema, and wrote almost nothing.
#
# Off-box is REPORTED, NOT FAILED. BACKUP_REMOTE is unset today and that is the
# owner's outstanding decision, not a regression; a gate that failed on it would
# be red every run until somebody bought storage, and a permanently red gate is
# a gate people stop reading. It says so instead, every time.
#
# WHAT IT IS NOT. This runs when somebody runs it. It closes the hole where
# nothing COULD notice, not the hole where nobody is looking — that one needs a
# destination for alerts, which this platform still does not have.
set -uo pipefail

NEXUS_DIR="${NEXUS_DIR:-/opt/nexus}"
BACKUP_DIR="${BACKUP_DIR:-$NEXUS_DIR/backups}"
BACKUP_LOG="${BACKUP_LOG:-/var/log/nexus-backup.log}"
# 26 hours: the schedule is 03:15 daily, and a check run at 03:00 must not fail
# for a backup that is 23 hours old and perfectly healthy.
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"

# Needed only for the backup_runs read below. Spelled the same way backup-db.sh
# spells them, because the two now share a table and a pair of names that drift
# is a pair that eventually points at different databases.
COMPOSE=(docker compose -f "$NEXUS_DIR/docker-compose.prod.yml")
DB_USER="${DB_USER:-nexus}"
DB_NAME="${DB_NAME:-nexus}"

fail() { echo "FAIL — $*"; exit 1; }

# ---- 1. is there anything at all -------------------------------------------
[ -d "$BACKUP_DIR" ] || fail "no backup directory at $BACKUP_DIR. Nothing has ever been dumped."

# Nightly dumps only. The nexus-pre-NNN files are hand-taken migration
# snapshots; counting one as last night's backup would let the nightly job be
# dead for a fortnight while this stayed green.
newest="$(ls -1t "$BACKUP_DIR"/nexus-[0-9]*.sql.gz 2>/dev/null | head -1)"
[ -n "$newest" ] || fail "no nightly dump in $BACKUP_DIR (only hand-taken snapshots, if any)."

# ---- 2. is it last night's -------------------------------------------------
now="$(date -u +%s)"
mtime="$(date -u -r "$newest" +%s 2>/dev/null || stat -c %Y "$newest")"
age_hours=$(( (now - mtime) / 3600 ))
if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
  fail "the newest dump is ${age_hours}h old (limit ${MAX_AGE_HOURS}h): $(basename "$newest").
       The nightly job has not produced a backup since then. Check the crontab and
       $BACKUP_LOG."
fi

# ---- 3. was it RESTORED, or merely written ---------------------------------
stamp="$(basename "$newest" | sed -E 's/^nexus-([0-9]{8}-[0-9]{6})\.sql\.gz$/\1/')"
[ "$stamp" != "$(basename "$newest")" ] || fail "cannot read a timestamp out of $(basename "$newest")"

# THE DATABASE ROW BEATS THE LOG, and only became available on 2026-08-27.
#
# This gate reads stdout that backup-db.sh wrote to a file the CRONTAB redirects
# it to. Run the script by hand without that redirect -- which I did twice in
# one morning while testing -- and the dump is perfect, restore-verified, and
# reported here as "the log has no record of dumping it. Check whether something
# other than backup-db.sh wrote it." A true alarm about a file that is fine.
#
# The script now records every run in `backup_runs`, which happens however it
# was invoked. That row is the fact; the log line was always a proxy for it.
# Matched on time rather than on the filename because the table records a run,
# not a file, and a run that produced a given dump is the one that happened
# within a few minutes of its timestamp.
#
# The log check below is KEPT as the fallback, for the case this cannot answer:
# a database that will not respond. It is not deleted just because something
# better usually works.
stamp_epoch="$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%s 2>/dev/null || echo 0)"
recorded=""
if [ "$stamp_epoch" -gt 0 ]; then
  # 1/0 RATHER THAN THE BOOLEAN. `psql -tA` prints a boolean column as `t`, but
  # the same value CONCATENATED into a string casts to `true` -- so a comparison
  # against "t" silently never matched, and this whole branch fell through to
  # the log check it was written to replace. It failed in the safe direction and
  # was invisible for exactly that reason: the gate still went red, for the old
  # wrong reason, and looked like the fix had not deployed.
  recorded="$("${COMPOSE[@]}" exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "select extract(epoch from ran_at)::bigint || ':' || (case when verified then 1 else 0 end)
       from backup_runs order by ran_at desc limit 1" 2>/dev/null | tr -d '[:space:]')"
fi

if [ -n "$recorded" ]; then
  row_epoch="${recorded%%:*}"
  row_verified="${recorded##*:}"
  drift=$(( stamp_epoch > row_epoch ? stamp_epoch - row_epoch : row_epoch - stamp_epoch ))
  if [ "$drift" -lt 900 ] && [ "$row_verified" = "1" ]; then
    echo "Restore verified: backup_runs has a verified run within $((drift))s of $stamp."
    verified_line="recorded in backup_runs, ${drift}s from the dump's own timestamp"
    run="(read from backup_runs rather than the log)"
  fi
fi

if [ -z "${run:-}" ] && [ ! -r "$BACKUP_LOG" ]; then
  # Not a pass. The dump may be perfect; this cannot tell, and saying so is the
  # whole point of the file it could not read.
  fail "no readable backup log at $BACKUP_LOG, so whether $stamp was ever restored
       is unknown. A dump nobody has restored is a file, not a backup."
fi

# Everything the log said from this dump's own run onwards -- consulted only
# when the table above did not already answer.
if [ -z "${run:-}" ]; then
  run="$(awk -v s="$stamp" 'index($0, "Dumping") && index($0, s) {found=1} found' "$BACKUP_LOG")"
fi
[ -n "$run" ] || fail "the log has no record of dumping $stamp. The file exists and nothing
       accounts for it — check whether something other than backup-db.sh wrote it."

echo "$run" | grep -qE "Verified:|backup_runs" || fail "dump $stamp was written but NEVER RESTORE-VERIFIED.
       backup-db.sh restores every dump into a scratch database; this one has no
       Verified line, so either that step failed or the run did not finish."

if [ -z "${verified_line:-}" ]; then
  verified_line="$(echo "$run" | grep -m1 "Verified:" | sed 's/^\[[^]]*\] //')"
fi

# ---- 4. is it a plausible size ---------------------------------------------
size="$(wc -c < "$newest")"
# Median-ish of the recent nightlies, without needing bc or python.
sizes="$(ls -1t "$BACKUP_DIR"/nexus-[0-9]*.sql.gz 2>/dev/null | head -7 | xargs -r wc -c | awk '$2 != "total" {print $1}' | sort -n)"
count="$(echo "$sizes" | grep -c .)"
if [ "$count" -ge 3 ]; then
  median="$(echo "$sizes" | awk -v n="$count" 'NR == int((n+1)/2) {print $1}')"
  floor=$(( median / 2 ))
  if [ "$size" -lt "$floor" ]; then
    fail "dump $stamp is $size bytes, less than half the recent median of $median.
       A dump can restore cleanly and still be nearly empty — that is what this catches."
  fi
fi

# ---- report ----------------------------------------------------------------
retained="$(ls -1 "$BACKUP_DIR"/nexus-[0-9]*.sql.gz 2>/dev/null | wc -l)"
echo "PASS - $(basename "$newest") is ${age_hours}h old, $((size / 1048576))MB, and restore-verified."
echo "       $verified_line"
echo "       $retained nightly dump(s) retained."

# Stated on every run, deliberately, and not a failure. See the header.
if echo "$run" | grep -q "Off-box copy: SKIPPED"; then
  echo "       NOT OFF-BOX: every copy is on the disk it is protecting. Losing that disk"
  echo "       loses the database and all $retained backups together. Set BACKUP_REMOTE."
fi
