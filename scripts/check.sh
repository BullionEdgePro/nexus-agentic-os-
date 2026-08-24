#!/usr/bin/env bash
#
# Typecheck and test, and say what happened in four lines.
#
#   ./scripts/check.sh
#
# ============================================================
# WHY THIS EXISTS
# ============================================================
#
# Because `npm test` prints about three thousand lines and the only ones anybody
# wants are the last three. So it gets piped:
#
#   npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && git commit ...
#
# and that command is WRONG IN A WAY THAT LOOKS RIGHT. `grep` exits 0 because it
# found the lines — including `fail 1` — so `&&` carries on and commits a red
# suite. That has now happened five times in this repository. Three of them were
# in one day, by somebody who had written two of the warnings about it, and the
# fifth was on 2026-08-24 within an hour of shipping a detector for the class.
#
# The detector cannot help: it reads shell scripts in the repository and this
# mistake is made at a prompt. The pre-commit hook now covers more of it, and
# still only fires at a commit.
#
# So the fix is the one `verify-all.sh` already made for the ten-command
# verification: MAKE THE RIGHT THING THE SHORT THING. Nobody pipes a command
# whose output is already four lines, and this one's exit code is its own.
#
# The lesson is not "be more careful". Five repetitions is what a process
# failure looks like, and the fix belongs in the repository rather than in
# anybody's discipline.
#
# ============================================================
# WHAT IT DOES NOT DO
# ============================================================
#
# It does not touch production and it is not `verify-all.sh`. This is the fast
# half — types and the suite, both of which run against source. Nothing here
# knows whether the running system works.
set -uo pipefail

cd "$(dirname "$0")/.."

# Never through a pipe. Output to a file, exit code on its own line — which is
# the entire point of this script and would be a poor joke to get wrong here.
log="$(mktemp)"

npm run typecheck > "$log" 2>&1
code=$?
if [ "$code" -ne 0 ]; then
  echo "TYPECHECK FAILED"
  grep -E "error TS" "$log" | head -15 | sed 's/^/  /'
  echo "  full output: $log"
  exit 1
fi
echo "typecheck  ok"

npm test > "$log" 2>&1
code=$?

# Read from the file, so this summary describes the run whose status was taken
# above rather than a second one.
tests="$(grep -E '^ℹ tests ' "$log" | tail -1 | tr -dc '0-9')"
passed="$(grep -E '^ℹ pass ' "$log" | tail -1 | tr -dc '0-9')"
failed="$(grep -E '^ℹ fail ' "$log" | tail -1 | tr -dc '0-9')"

if [ "$code" -ne 0 ] || [ "${failed:-1}" != "0" ]; then
  # BOTH conditions, because they can disagree. A suite that crashes before
  # reporting exits non-zero with no counts at all, and a summary that trusted
  # the counts alone would print "0 failed" over a run that never finished.
  echo "TESTS FAILED — ${failed:-?} of ${tests:-?}"
  grep -A 4 "^✖ failing tests:" "$log" | sed 's/^/  /' | head -40
  echo "  full output: $log"
  exit 1
fi

echo "tests      ok — ${passed} passed"
echo
echo "Source is good. This says NOTHING about the running system:"
echo "  ssh root@200.141.5.204 'cd /opt/nexus && ./scripts/verify-all.sh'"
rm -f "$log"
