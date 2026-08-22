#!/usr/bin/env bash
#
# Push this project's HEAD to the flat deploy repo the VPS pulls from.
#
#   cd nexus-agentic-os && ./scripts/mirror.sh
#
# Development happens in the `nexus-agentic-os/` subdirectory of the kova-audio
# monorepo. The VPS clones `BullionEdgePro/nexus-agentic-os-` -- note the
# trailing dash -- which carries the project FLAT at its root, because
# /opt/nexus/docker-compose.prod.yml has to be at /opt/nexus and not one level
# down. So every deploy needs the subdirectory copied to the root of another
# repo and pushed.
#
# THIS EXISTED ONLY IN SOMEBODY'S HEAD until now. It was hand-run three times,
# and the fourth time cost twenty minutes of reading a transcript to work out
# what the first three had done. A deploy step that is not written down is a
# deploy step that is done differently each time.
#
# WHAT IT MIRRORS IS HEAD, NOT THE DISK. `git archive HEAD:` is the whole
# mechanism: it cannot pick up an uncommitted edit, a node_modules, a .next, or
# a .env, because none of those are in the commit. The alternative -- copying
# the working tree -- is how you ship a secret.
#
# WHICH IS ALSO WHY IT REFUSES TO RUN ON A DIRTY TREE. Mirroring HEAD while the
# disk says something else deploys a commit behind and passes every gate doing
# it. That happened once already and cost an afternoon of believing a fix was
# live when the build predated it.
set -uo pipefail

MONO=$(git rev-parse --show-toplevel) || exit 1
SUB=nexus-agentic-os
REMOTE=https://github.com/BullionEdgePro/nexus-agentic-os-.git
WORK=${TMPDIR:-/tmp}/nexus-mirror

cd "$MONO" || exit 1

if [ -n "$(git status --porcelain -- "$SUB")" ]; then
  echo "REFUSING: $SUB has uncommitted changes, and this mirrors HEAD."
  echo "Mirroring now would deploy a commit behind and every gate would pass."
  git status --short -- "$SUB"
  exit 1
fi

SRC=$(git rev-parse --short HEAD)
SUBJECT=$(git log -1 --format=%s)
BODY=$(git log -1 --format=%b)

# gh authenticates as a different account on this machine and hijacks
# github.com, so ask the credential manager directly.
GIT="git -c credential.helper= -c credential.helper=manager"

# ASK GIT, DO NOT LOOK FOR A DIRECTORY. `[ -d "$WORK/.git" ]` was the first
# version and it is not the same question: an interrupted clone leaves a .git
# directory that exists and is not a repository, so the test passed, the fetch
# ran, and the whole deploy stopped on "fatal: not a git repository" with a
# perfectly good checkout sitting next to it. Happened once, cost a deploy.
if $GIT -C "$WORK" rev-parse --git-dir >/dev/null 2>&1; then
  $GIT -C "$WORK" fetch -q origin main && $GIT -C "$WORK" reset -q --hard origin/main || exit 1
else
  # Covers "not there at all" and "there but broken" with the same branch,
  # which is the point of asking git rather than the filesystem.
  rm -rf "$WORK"
  $GIT clone -q "$REMOTE" "$WORK" || exit 1
fi

# A fresh clone in a temp directory inherits no identity, and this machine has
# no global one -- the monorepo sets it per-repo. Carry it across, or the commit
# below dies on "unable to auto-detect email address".
git -C "$WORK" config user.name  "$(git config user.name)"
git -C "$WORK" config user.email "$(git config user.email)"

# Everything tracked in the subdirectory of THIS commit, unpacked at the root of
# the mirror. --overwrite because the clone is already populated.
git archive "HEAD:$SUB" | tar -x -C "$WORK" --overwrite || exit 1

# Deletions do not propagate through an unpack, so remove what HEAD no longer
# carries. Scoped to tracked files, which is why this is `git rm` and not `rm`.
KEEP=$(git ls-tree -r --name-only "HEAD:$SUB" | sort)
HAVE=$(git -C "$WORK" ls-files | sort)
GONE=$(comm -13 <(echo "$KEEP") <(echo "$HAVE"))
if [ -n "$GONE" ]; then
  echo "$GONE" | while read -r f; do
    [ -n "$f" ] && git -C "$WORK" rm -q --ignore-unmatch -- "$f"
  done
fi

git -C "$WORK" add -A

# THE EXEC BIT DOES NOT SURVIVE THE UNPACK, and this script was its own proof.
#
# core.fileMode is false on the machine this runs from, and tar drops the mode
# on Windows, so `add -A` re-records whatever the mirror already had. Existing
# executables therefore keep 755 BY LUCK -- nothing here preserved them, they
# were simply never changed. A NEW executable is recorded 644 on the commit that
# introduces it and stays that way forever.
#
# mirror.sh itself shipped 644 in both repos for exactly this reason: it was the
# newest script, so it was the one file with no prior mode to inherit. It ran
# anyway from Git Bash, which honours the filesystem rather than the index, and
# would have failed with "Permission denied" for anyone who cloned on Linux.
#
# DERIVED FROM THE SOURCE TREE, not the mirror's HEAD. Reading the mirror can
# only re-assert bits on files it already has, which is the same blind spot one
# level along. HANDOFF §2 documents this trap; following it by hand on
# 2026-08-19 demoted verify-all.sh, which is how the ten gates are run.
git -C "$MONO" ls-tree -r "HEAD:$SUB" | awk '$1=="100755"{print $4}' |
  while read -r f; do
    [ -n "$f" ] && git -C "$WORK" update-index --chmod=+x -- "$f" 2>/dev/null
  done

# Silent until something will not run, so say it now rather than on the VPS.
if git -C "$WORK" diff --cached --summary | grep -q "mode change .* => 100644"; then
  echo "REFUSING: something executable was demoted to 644 in the mirror."
  git -C "$WORK" diff --cached --summary | grep "mode change"
  exit 1
fi

if git -C "$WORK" diff --cached --quiet; then
  echo "Mirror already matches $SRC. Nothing to push."
  exit 0
fi

# Same subject as the monorepo commit, with the source named -- the two repos
# have unrelated histories and the sha is the only thread between them.
git -C "$WORK" commit -q -m "$SUBJECT" -m "$BODY" -m "Mirrored from kova-audio $SRC" || exit 1
$GIT -C "$WORK" push -q origin main || { echo "Push failed."; exit 1; }

echo "Mirrored $SRC -> $(git -C "$WORK" rev-parse --short HEAD)"
echo "Now deploy: ssh root@200.141.5.204 'cd /opt/nexus && ./scripts/deploy.sh'"
