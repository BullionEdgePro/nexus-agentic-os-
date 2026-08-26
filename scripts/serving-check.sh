#!/usr/bin/env bash
#
# Does anybody OUTSIDE this machine get an answer?
#
#   cd /opt/nexus && ./scripts/serving-check.sh
#
# ============================================================
# THE QUESTION ELEVEN GATES DID NOT ASK
# ============================================================
#
# Eight of the gates run as `docker compose exec -T worker npx tsx ...` — inside
# the worker container, against the database on the internal network. Three run
# on the host and read images, schema and backups. Not one of them makes an HTTP
# request to anything this platform serves.
#
# So every one of these could be true while verify-all.sh printed "All gates
# pass":
#
#   - the api container is wedged, accepting connections and answering nothing
#   - Caddy is routing api.<domain> at the wrong upstream
#   - the TLS certificate expired overnight
#   - DNS moved
#   - the web console returns 500 on every page
#
# Every gate would still pass, because every gate runs on the inside. "All gates
# pass" was a statement about the platform's LOGIC that reads as a statement
# about the platform, and it is the sentence a deploy is signed off with.
#
# This gate is therefore deliberately the dumbest one and the only one that
# comes from outside: it asks the public hostnames, over the public internet,
# the way an operator opening the deck and Meta delivering a webhook do.
#
# ============================================================
# WHAT IT DOES NOT DO
# ============================================================
#
# It does not check the commit. build-check already compares every running
# image's NEXUS_COMMIT to the working copy, and the alternative — publishing the
# deployed revision on an unauthenticated endpoint so this script could read it
# — hands an anonymous caller a fingerprint of exactly which build is running,
# for a fact already established by other means. /health/jobs stripped free-text
# error messages for that reason; adding a commit SHA back is the same trade in
# the other direction.
#
# It does not sign in. Everything here is reachable anonymously by design: an
# uptime check that needs a session is one nobody wires up.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

fail=0
note() { printf '  %s\n' "$1"; }

# ------------------------------------------------------------
# Where to look
# ------------------------------------------------------------
if [ ! -f .env ]; then
  echo "FAIL - no .env, so there is no way to know which hostnames to ask."
  exit 1
fi

api_domain=$(grep -E '^API_DOMAIN=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)
web_domain=$(grep -E '^WEB_DOMAIN=' .env | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs)

if [ -z "$api_domain" ] || [ -z "$web_domain" ]; then
  echo "FAIL - API_DOMAIN or WEB_DOMAIN is unset in .env."
  note "Without both, this gate would silently check nothing and pass."
  exit 1
fi

# --max-time so a hung endpoint fails the gate rather than hanging the deploy.
# No --insecure anywhere: an expired or wrong certificate must fail here, since
# that is precisely one of the outages the inside-only gates cannot see.
CURL="curl --silent --show-error --max-time 20"

echo "Asking the public hostnames, from outside the containers."
echo

# ------------------------------------------------------------
# 1. Does the API answer at all?
# ------------------------------------------------------------
printf '%-24s ' "api /health"
health=$($CURL --write-out '\n%{http_code}' "https://${api_domain}/health" 2>&1)
health_code=$(printf '%s' "$health" | tail -1)
health_body=$(printf '%s' "$health" | sed '$d')

if [ "$health_code" = "200" ] && printf '%s' "$health_body" | grep -q '"status":"ok"'; then
  echo "PASS"
else
  echo "FAIL"
  note "https://${api_domain}/health returned ${health_code:-no response}"
  note "${health_body:-no body}"
  note "Nothing below this line means much if the API is not answering."
  fail=1
fi

# ------------------------------------------------------------
# 2. Is the background half alive?
# ------------------------------------------------------------
#
# THE ENDPOINT THAT NOTHING CALLED. /health/jobs was built (migration 050)
# because a dead operator sweep is invisible from the inside: all fifteen
# operators go quiet and the deck reports zero standing findings, which reads
# exactly like a clean week. It is correct, it is tested, and until this gate
# existed the only thing that would ever have noticed was a person choosing to
# curl it by hand.
#
# Its own `ok` already folds in the distinction the rest of today's work is
# about: `queuesUnreadable` counts against ok, because "I could not check" must
# not answer a monitor the same way as "nothing is wrong".
printf '%-24s ' "api /health/jobs"
jobs=$($CURL --write-out '\n%{http_code}' "https://${api_domain}/health/jobs" 2>&1)
jobs_code=$(printf '%s' "$jobs" | tail -1)
jobs_body=$(printf '%s' "$jobs" | sed '$d')

if [ "$jobs_code" != "200" ]; then
  echo "FAIL"
  note "returned ${jobs_code:-no response}"
  fail=1
elif printf '%s' "$jobs_body" | grep -q '"ok":true'; then
  echo "PASS"
else
  echo "FAIL"
  # Named, not just counted. "Something is stalled" sends somebody to read JSON;
  # the job's name sends them to the right log.
  for field in stalled failing backedUp; do
    listed=$(printf '%s' "$jobs_body" | grep -oE "\"${field}\":\[[^]]*\]" | sed -E "s/\"${field}\":\[//; s/\]//; s/\"//g")
    [ -n "$listed" ] && note "${field}: ${listed}"
  done
  printf '%s' "$jobs_body" | grep -q '"queuesUnreadable":true' &&
    note "queuesUnreadable: Redis could not be read, so the queue half of this answer is missing"
  fail=1
fi

# ------------------------------------------------------------
# 3. Does the console load?
# ------------------------------------------------------------
#
# A redirect counts. The deck is behind a session and an anonymous GET is
# supposed to be sent to /login — what is being checked is that Next.js is
# serving and Caddy is pointed at it, not what it decided to serve.
printf '%-24s ' "web console"
web_code=$($CURL --output /dev/null --write-out '%{http_code}' "https://${web_domain}/" 2>&1)

case "$web_code" in
  200|301|302|303|307|308)
    echo "PASS"
    ;;
  *)
    echo "FAIL"
    note "https://${web_domain}/ returned ${web_code:-no response}"
    note "The gates all run inside the worker; none of them would have noticed this."
    fail=1
    ;;
esac

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS - the API answers, its background schedule is alive, and the console serves."
  exit 0
fi

echo "FAIL - something this platform serves is not reachable from outside."
exit 1
