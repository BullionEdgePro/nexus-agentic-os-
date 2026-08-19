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

$COMPOSE build api worker web || { echo "Build failed."; exit 1; }
$COMPOSE up -d --no-deps api worker web || { echo "Restart failed."; exit 1; }

echo
./scripts/build-check.sh
