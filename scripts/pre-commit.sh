#!/usr/bin/env bash
#
# Refuse a commit that would take red tests with it.
#
# Install once, from the monorepo root:
#
#   git config core.hooksPath nexus-agentic-os/scripts/githooks
#
# ============================================================
# WHY THIS EXISTS
# ============================================================
#
# On 18 August a commit went out with three failing tests in its own test file.
# The command was:
#
#   npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖" && git commit ...
#
# `grep` SUCCEEDED — it found the failure lines — so `&&` carried on and pushed.
# That is the pipe-swallows-the-exit-code mistake DEPLOY.md warns about, that
# `verify-all.sh` was written to avoid, and it was made by hand three times in
# one day by somebody who had written both warnings.
#
# The lesson is not "be more careful". Three repetitions in a day is what a
# process failure looks like, and the fix belongs in the repository rather than
# in anybody's discipline: the commit itself now checks, so a wrong shell chain
# cannot get past it.
#
# ============================================================
# WHY IT IS NARROW
# ============================================================
#
# A hook that runs a minute of checks on a one-line documentation edit is a hook
# people disable, and most commits in this project are prose. So it runs only
# when the staged changes include code THIS project builds, and it says which
# files triggered it — a check that fires invisibly is as bad as one that never
# fires.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
PROJECT="$ROOT/nexus-agentic-os"

# Staged code, this project only. The monorepo holds several other applications
# and their commits are none of this hook's business.
staged="$(git diff --cached --name-only --diff-filter=ACM \
  | grep -E '^nexus-agentic-os/.*\.(ts|tsx|mjs|js)$' || true)"

if [ -z "$staged" ]; then
  exit 0
fi

# A working copy without dependencies is the deployment mirror, which receives
# an exported tree and has no node_modules. Checking there would fail for a
# reason that has nothing to do with the change.
if [ ! -d "$PROJECT/node_modules" ]; then
  echo "pre-commit: no node_modules in $PROJECT — skipping checks (mirror or fresh clone)"
  exit 0
fi

echo "pre-commit: $(echo "$staged" | wc -l | tr -d ' ') code file(s) staged, running typecheck and tests"
echo "$staged" | sed 's/^/  /'

# Output to a file and the exit code read on its own line. Reading it through a
# pipe is the exact defect this hook exists to catch, and writing that here
# would be its own punchline.
log="$(mktemp)"
( cd "$PROJECT" && npm run typecheck ) > "$log" 2>&1
code=$?
if [ "$code" -ne 0 ]; then
  echo "pre-commit: TYPECHECK FAILED"
  tail -20 "$log" | sed 's/^/  /'
  echo "pre-commit: full output in $log"
  exit 1
fi

( cd "$PROJECT" && npm test ) > "$log" 2>&1
code=$?
if [ "$code" -ne 0 ]; then
  echo "pre-commit: TESTS FAILED"
  grep -E '^✖|^ℹ (tests|pass|fail)' "$log" | tail -20 | sed 's/^/  /'
  echo "pre-commit: full output in $log"
  exit 1
fi

echo "pre-commit: typecheck and $(grep -oE '^ℹ pass [0-9]+' "$log" | tail -1 | grep -oE '[0-9]+') tests pass"
rm -f "$log"
