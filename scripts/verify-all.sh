#!/usr/bin/env bash
#
# Run every gate, in the order that makes their answers mean something.
#
#   cd /opt/nexus && ./scripts/verify-all.sh
#
# WHY THIS EXISTS. There are seven gates now, and the only record of how to run
# them was seven separate commands in prose. Verification that costs seven
# copy-pastes is verification that gets done on the days somebody has time,
# which are not the days it matters. Every one of these has caught something no
# unit test could, and each was found by somebody remembering to run it.
#
# THE ORDER IS NOT ALPHABETICAL AND IS NOT A PREFERENCE.
#
#   schema-check first, always. It is the only one that plans SQL that has never
#   executed, so it is the one that fails on a migration that was written and
#   not applied — and every gate after it would otherwise fail in a way that
#   looks like a feature bug rather than a missing column.
#
#   shared-number-check before the reply-path checks. All five businesses answer
#   on one number, and when a serving business is unreadable from the owner's
#   transaction the later gates still pass: they scope themselves to each
#   business directly, which is the one context in which that defect is
#   invisible. Knowing the reads are sound first makes the rest interpretable.
#
#   retrieval-check last because it is the slow one — one embedding request per
#   probe, eighteen today — and because a provider outage makes it fail for a
#   reason that has nothing to do with the deploy being verified.
#
# EXIT CODES ARE READ DIRECTLY, NEVER THROUGH A PIPE. `... | tail -3; echo $?`
# reports tail's exit code, so a failing gate prints 0 — a mistake this project
# has already made once with a migration, and the reason DEPLOY.md warns about
# it. Output goes to a file and $? is read on the next line.
set -uo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
OUT_DIR="${TMPDIR:-/tmp}/nexus-verify"
mkdir -p "$OUT_DIR"

# The last one is optional because of its cost, not because it matters less.
GATES=(
  schema-check
  shared-number-check
  rls-preflight
  rls-verify
  operator-fire-check
  self-check
  retrieval-check
)

SKIP_SLOW=0
for arg in "$@"; do
  case "$arg" in
    --fast) SKIP_SLOW=1 ;;
    *) echo "unknown argument: $arg (only --fast is understood)"; exit 2 ;;
  esac
done

echo "Verifying $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown revision')"
echo

declare -a NAMES=()
declare -a CODES=()
failed=0

for gate in "${GATES[@]}"; do
  if [ "$SKIP_SLOW" = "1" ] && [ "$gate" = "retrieval-check" ]; then
    NAMES+=("$gate"); CODES+=("skipped")
    continue
  fi

  printf '%-22s ' "$gate"
  $COMPOSE exec -T worker npx tsx "apps/api/src/scripts/${gate}.ts" > "$OUT_DIR/${gate}.out" 2>&1
  code=$?

  NAMES+=("$gate")
  if [ "$code" -eq 0 ]; then
    CODES+=("PASS")
    echo "PASS"
  else
    CODES+=("FAIL($code)")
    failed=$((failed + 1))
    echo "FAIL — $OUT_DIR/${gate}.out"
    # The last few lines inline as well as in the file, because a gate that
    # fails at 3am is read from whatever scrolled past.
    tail -5 "$OUT_DIR/${gate}.out" | sed 's/^/    /'
  fi
done

echo
echo "----------------------------------------"
for i in "${!NAMES[@]}"; do
  printf '  %-22s %s\n' "${NAMES[$i]}" "${CODES[$i]}"
done
echo "----------------------------------------"
echo "Full output in $OUT_DIR"

if [ "$SKIP_SLOW" = "1" ]; then
  # Named rather than silent. A run that skipped the slow gate and printed the
  # same "all pass" as a full one is a summary that lies by omission.
  echo
  echo "NOTE: --fast skipped retrieval-check. Retrieval quality is UNVERIFIED by this run."
fi

if [ "$failed" -gt 0 ]; then
  echo
  echo "$failed of ${#NAMES[@]} gates failed."
  exit 1
fi

echo
echo "All gates pass."
