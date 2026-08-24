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

if [ ! -r "$BACKUP_LOG" ]; then
  # Not a pass. The dump may be perfect; this cannot tell, and saying so is the
  # whole point of the file it could not read.
  fail "no readable backup log at $BACKUP_LOG, so whether $stamp was ever restored
       is unknown. A dump nobody has restored is a file, not a backup."
fi

# Everything the log said from this dump's own run onwards.
run="$(awk -v s="$stamp" 'index($0, "Dumping") && index($0, s) {found=1} found' "$BACKUP_LOG")"
[ -n "$run" ] || fail "the log has no record of dumping $stamp. The file exists and nothing
       accounts for it — check whether something other than backup-db.sh wrote it."

echo "$run" | grep -q "Verified:" || fail "dump $stamp was written but NEVER RESTORE-VERIFIED.
       backup-db.sh restores every dump into a scratch database; this one has no
       Verified line, so either that step failed or the run did not finish."

verified_line="$(echo "$run" | grep -m1 "Verified:" | sed 's/^\[[^]]*\] //')"

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
