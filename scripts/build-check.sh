#!/usr/bin/env bash
#
# Is what is RUNNING what is COMMITTED?
#
#   cd /opt/nexus && ./scripts/build-check.sh
#
# Every other gate talks to the API. None of them can see that the deck is
# running yesterday's build, because the deck is a separate image built by a
# separate command that a person types by hand -- `build api worker` without
# `web` is a complete, successful-looking deploy that ships nothing to the
# screen anybody actually looks at.
#
# On 2026-08-19 the web image was current. The only way to establish that was to
# read `docker image inspect --format {{.Created}}` against `git log -1 --
# apps/web` and compare two timestamps by eye, in different timezones. That is
# not a check, it is a habit, and it is the kind that holds until the day it
# matters.
#
# So each image now carries the commit it was built from (ARG GIT_COMMIT ->
# ENV NEXUS_COMMIT) and this compares all three against the working copy.
#
# WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the image was built from this
# revision. It cannot prove the build was clean, and it cannot see a source file
# edited on the VPS after the build -- `git status` below covers that second
# case, which is exactly how the drift-check files got onto this machine.
set -uo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
SERVICES="api worker web"

head_commit=$(git rev-parse --short HEAD 2>/dev/null)
if [ -z "$head_commit" ]; then
  echo "FAIL - not a git working copy, so there is nothing to compare against."
  exit 1
fi

echo "Working copy is at $head_commit"

# IS THE WORKING COPY ITSELF BEHIND?
#
# Everything below compares the running images to the WORKING COPY, which
# answers "was this built from what is checked out" and not "is what is checked
# out current". Those came apart on 2026-08-19: a pull aborted on an untracked
# file, deploy.sh correctly refused to continue, and a verify run afterwards
# reported all three images matching — because they matched a checkout one
# commit old. Every gate passed against a build that did not include the commit
# being verified.
#
# The fetch is best-effort. No network is a reason to say so, not a reason to
# fail a check about images.
behind=""
if git fetch --quiet origin main 2>/dev/null; then
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null)
fi
if [ -n "$behind" ] && [ "$behind" != "0" ]; then
  echo
  echo "STOP: the working copy is $behind commit(s) behind origin/main."
  echo "      Everything below compares images to THIS checkout, so it can only"
  echo "      tell you they match something stale. Pull first:  ./scripts/deploy.sh"
  echo
fi

dirty=$(git status --porcelain 2>/dev/null | grep -vE "^\?\?" | head -20)
if [ -n "$dirty" ]; then
  # Not a failure on its own: a file edited and not yet built is a state a
  # person can be deliberately in. Named, because an image matching HEAD while
  # the working copy has moved on is the most confusing version of "up to date".
  echo
  echo "NOTE: tracked files differ from HEAD, so HEAD is not what is on disk:"
  echo "$dirty" | sed 's/^/    /'
fi

echo
failed=0
for service in $SERVICES; do
  printf '  %-8s ' "$service"
  stamp=$($COMPOSE exec -T "$service" printenv NEXUS_COMMIT 2>/dev/null | tr -d '\r\n')

  if [ -z "$stamp" ]; then
    # An image built before the stamp existed has no variable at all. Reported
    # as its own case: "cannot tell" and "wrong" need different actions.
    echo "NO STAMP - built before build-check existed, or not running. Rebuild it."
    failed=$((failed + 1))
    continue
  fi

  if [ "$stamp" = "unknown" ]; then
    echo "unknown - built without GIT_COMMIT. Use ./scripts/deploy.sh."
    failed=$((failed + 1))
    continue
  fi

  if [ "$stamp" = "$head_commit" ]; then
    echo "$stamp"
  else
    echo "$stamp - STALE, working copy is $head_commit"
    failed=$((failed + 1))
  fi
done

echo
if [ "$failed" -gt 0 ]; then
  echo "$failed of 3 running images do not match the working copy."
  echo "Rebuild them: ./scripts/deploy.sh"
  exit 1
fi

if [ -n "$behind" ] && [ "$behind" != "0" ]; then
  # Deliberately a failure rather than the note printed above. A warning sitting
  # over three green ticks gets read as green, which is precisely how a stale
  # build passed a full verify run the day this was written.
  echo "FAIL - images match the working copy, but the working copy is $behind commit(s) behind."
  exit 1
fi

echo "PASS - all three running images were built from $head_commit, and it is current."
