#!/usr/bin/env bash
#
# Run every gate, in the order that makes their answers mean something.
#
#   cd /opt/nexus && ./scripts/verify-all.sh
#
# WHY THIS EXISTS. There are ten gates now, and the only record of how to run
# them was seven separate commands in prose. Verification that costs seven
# copy-pastes is verification that gets done on the days somebody has time,
# which are not the days it matters. Every one of these has caught something no
# unit test could, and each was found by somebody remembering to run it.
#
# THE ORDER IS NOT ALPHABETICAL AND IS NOT A PREFERENCE.
#
#   build-check first of all, because it decides what the rest of this run is
#   about. Every other gate exercises the application's own code in process, so
#   none of them can see that the deck is running an older image — and a suite
#   that passes while the screen shows yesterday's code is worse than one that
#   fails. It is also the only check whose answer changes the meaning of every
#   answer after it: gates that pass against a stale build have verified the
#   stale build.
#
#   That sentence used to read "every other gate talks to the API", and that is
#   how the hole below went unnoticed for as long as it did: it was written down
#   as covered. They do not talk to the API. Eight of them run as
#   `compose exec -T worker npx tsx`, in a container, against Postgres on the
#   internal network; the other three read images, schema and backups on the
#   host. Nothing here made an HTTP request to anything this platform serves.
#
#   serving-check second, and it is the only gate that comes from OUTSIDE.
#   Everything above and below it would pass unchanged on a platform nobody
#   could reach — a wedged api container, Caddy pointed at the wrong upstream,
#   an expired certificate, DNS moved. "All gates pass" is the line a deploy is
#   signed off with, and until this gate existed it was a claim about the
#   platform's logic being read as a claim about the platform. It also calls
#   /health/jobs, which was built to notice a dead operator sweep and which,
#   until now, nothing in this repository ever called.
#
#   schema-check next, and first among the ones that touch the database. It is the only one that plans SQL that has never
#   executed, so it is the one that fails on a migration that was written and
#   not applied — and every gate after it would otherwise fail in a way that
#   looks like a feature bug rather than a missing column.
#
#   schema-drift-check straight after it, and for the same reason one step
#   further out. schema-check proves the SQL the application plans plans; this
#   proves the SCHEMA IS THE ONE THE REPOSITORY DESCRIBES, by building it from
#   scratch in a throwaway database and diffing. It is the only check that can
#   see a migration written and never applied, a change made in production by
#   hand, and a fresh install that would not complete -- it found all three on
#   2026-08-19, including four tenant tables with no row-level security.
#
#   shared-number-check before the reply-path checks. All five businesses answer
#   on one number, and when a serving business is unreadable from the owner's
#   transaction the later gates still pass: they scope themselves to each
#   business directly, which is the one context in which that defect is
#   invisible. Knowing the reads are sound first makes the rest interpretable.
#
#   deep-link-check early and cheaply. It calls no model and touches two
#   registry tables, and it guards the mechanism the four pending website edits
#   depend on entirely — if a tag stops routing, those links publish and every
#   customer still lands in the triage menu, which looks like the edits failed.
#
#   backup-check near the end, because it is the only gate that says nothing
#   about whether this deploy works. It answers a different question -- whether
#   the thing that gets you back if it does not is still standing -- and that
#   question was previously asked by nobody at all: backup-db.sh restores every
#   dump into a scratch database and writes the result to a log no script, gate
#   or endpoint had ever opened.
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
  build-check
  # The only one that asks from outside. Reasoning in the header above.
  serving-check
  schema-check
  schema-drift-check
  shared-number-check
  deep-link-check
  rls-preflight
  rls-verify
  operator-fire-check
  self-check
  backup-check
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
unverified=0
UNVERIFIED_NAMES=()

for gate in "${GATES[@]}"; do
  if [ "$SKIP_SLOW" = "1" ] && [ "$gate" = "retrieval-check" ]; then
    NAMES+=("$gate"); CODES+=("skipped")
    continue
  fi

  printf '%-22s ' "$gate"
  # One of these is a shell script rather than a tsx gate: it builds the schema
  # this repository describes in a throwaway database and diffs it against
  # production, which is not something that can run from inside the app's own
  # container against the app's own connection. A gate that has to be remembered
  # separately is a gate that gets run on the days somebody has time, which is
  # the reason this file exists at all -- so it runs here, with a special case,
  # rather than in a paragraph of prose.
  if [ "$gate" = "schema-drift-check" ] || [ "$gate" = "build-check" ] ||
    [ "$gate" = "backup-check" ] || [ "$gate" = "serving-check" ]; then
    "./scripts/${gate}.sh" > "$OUT_DIR/${gate}.out" 2>&1
  else
    $COMPOSE exec -T worker npx tsx "apps/api/src/scripts/${gate}.ts" > "$OUT_DIR/${gate}.out" 2>&1
  fi
  code=$?

  NAMES+=("$gate")
  if [ "$code" -eq 0 ]; then
    CODES+=("PASS")
    echo "PASS"
  elif [ "$code" -eq 75 ]; then
    # THE THIRD OUTCOME, and it exists because two gates call a model provider.
    #
    # On 2026-08-27 Google returned 503 twice inside twenty minutes and this
    # printed FAIL beside self-check and retrieval-check. Nothing was wrong with
    # the platform, and the only way to know that was to open the output file
    # and read a stack trace. A gate that goes red for a reason the reader
    # cannot act on teaches them to re-run rather than read.
    #
    # It is NOT counted as a pass. Retrieval quality genuinely was not checked,
    # and the summary below refuses to say "All gates pass" while any gate stood
    # down -- the same rule /health/jobs applies to `queuesUnreadable`: "I could
    # not check" is not "nothing is wrong".
    CODES+=("UNVERIFIED")
    unverified=$((unverified + 1))
    UNVERIFIED_NAMES+=("$gate")
    echo "UNVERIFIED — the model provider did not answer"
    tail -4 "$OUT_DIR/${gate}.out" | sed 's/^/    /'
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

# A RUN THAT CHECKED LESS THAN IT LOOKS LIKE MUST NOT SAY OTHERWISE.
#
# Exits 0, because nothing is known to be broken and a deploy blocked by
# somebody else's outage helps nobody. Says so loudly, because "All gates pass"
# is the sentence this whole file is read for, and printing it after a gate
# stood down would make it mean less every time it appeared.
if [ "$unverified" -gt 0 ]; then
  echo
  echo "PASS, WITH ${unverified} UNVERIFIED: ${UNVERIFIED_NAMES[*]}"
  echo "Nothing failed. But those gates could not reach the model provider, so"
  echo "what they check is neither confirmed nor denied by this run. Re-run them"
  echo "once it is back:  ./scripts/verify-all.sh"
  exit 0
fi

echo
echo "All gates pass."
