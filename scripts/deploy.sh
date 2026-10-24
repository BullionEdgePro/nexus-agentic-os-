#!/usr/bin/env bash
#
# Pull, build all three images with the commit stamped in, restart, verify.
#
#   cd /opt/nexus && ./scripts/deploy.sh
#
# THE ARGUMENT THIS EXISTS TO STOP ANYONE FORGETTING is GIT_COMMIT. Building by
# hand still works and stamps "unknown", which build-check reports as a failure
# -- deliberately, because an unstamped image is one nobody can tell the age of,
# which is the state this whole mechanism exists to end.
#
# BUILDS ALL THREE. The documented deploy was `build api worker`, and `web` was
# left to whoever remembered it. Every gate talks to the API, so a forgotten web
# build is a deploy where everything passes and the screen does not change.
set -uo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"

git pull --ff-only origin main || {
  echo "Pull failed. Untracked files in the way are the usual cause -- move them, do not delete them."
  exit 1
}

GIT_COMMIT=$(git rev-parse --short HEAD)
export GIT_COMMIT
echo "Building $GIT_COMMIT"

# Retried (24 Oct 2026): a Google Fonts outage can fail the web build outright,
# not just fall back, and the next run a minute later builds cleanly.
for build_attempt in 1 2 3; do
  $COMPOSE build api worker web && break
  [ "$build_attempt" = 3 ] && { echo "Build failed three times."; exit 1; }
  echo "Build failed (attempt $build_attempt of 3) -- retrying in 30 seconds."
  sleep 30
done

# FONTS ARE CHECKED, NOT ASSUMED (22 Oct 2026). next/font downloads the
# typefaces from Google at build time and, when that download fails, quietly
# falls back to system fonts -- the build passes, build-check passes, and the
# site ships looking wrong. It failed on two of three builds in one afternoon.
# So the built CSS is asked whether it holds the fonts, and the web image is
# rebuilt uncached until it does, three tries at most, before anything restarts.
fonts_in_web() {
  docker run --rm --entrypoint sh nexus-web -c 'cat /app/apps/web/.next/static/css/*.css' 2>/dev/null \
    | grep -o "@font-face" | wc -l
}
for attempt in 1 2 3; do
  [ "$(fonts_in_web)" -gt 0 ] && break
  echo "The web build has no fonts (the Google Fonts download failed) -- rebuilding web, attempt $attempt of 3."
  $COMPOSE build --no-cache web || { echo "Build failed."; exit 1; }
done
[ "$(fonts_in_web)" -gt 0 ] || { echo "The web build still has no fonts after 3 tries -- not deploying it."; exit 1; }
$COMPOSE up -d --no-deps api worker web || { echo "Restart failed."; exit 1; }

echo
./scripts/build-check.sh
