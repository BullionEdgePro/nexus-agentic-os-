#!/usr/bin/env bash
# ============================================================
# Deepen a tenant's knowledge base from its own website.
# ============================================================
#
#   ./scripts/ingest-tenant-knowledge.sh juris-prime
#   ./scripts/ingest-tenant-knowledge.sh juris-prime-legal
#   ./scripts/ingest-tenant-knowledge.sh sfs-international
#
# Run from /opt/nexus on the VPS. Needs NEXUS_API_TOKEN set in .env — it ships
# EMPTY, which disables bearer auth entirely (see requireAuth: an unset token
# must never let an empty bearer through). To enable it, without ever printing
# the value:
#
#   TOKEN=$(openssl rand -hex 32)
#   sed -i "s|^NEXUS_API_TOKEN=.*|NEXUS_API_TOKEN=$TOKEN|" .env
#   docker compose -f docker-compose.prod.yml up -d api
#
# Why this exists: three tenants became reachable by real customers the moment
# the shared number went live, each carrying only ~11 chunks from 3-4 pages.
# Thin knowledge does not produce wrong answers — the governance judge catches
# those — it produces vague ones and constant escalation, which is the failure
# an operator actually feels.
#
# The URL lists are CURATED, not crawled. What was left out matters more than
# what was included; see each block.

set -euo pipefail

SLUG="${1:-}"
API="${NEXUS_INGEST_API:-https://api.nexusagenticos.com}"
PACE="${NEXUS_INGEST_PACE:-2}"   # seconds between pages — the Gemini free tier
                                 # has already returned 429 on this project

if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <tenant-slug>" >&2
  exit 2
fi

if [[ -f .env ]]; then
  TOKEN="$(awk -F= '/^NEXUS_API_TOKEN=/{print substr($0, index($0,"=")+1)}' .env | tr -d '"'"'"'\r')"
else
  TOKEN="${NEXUS_API_TOKEN:-}"
fi

if [[ -z "$TOKEN" ]]; then
  echo "NEXUS_API_TOKEN is empty — bearer auth is disabled, so every request would 401." >&2
  echo "See the header of this script for how to set one." >&2
  exit 1
fi

# ------------------------------------------------------------
# Curated sources
# ------------------------------------------------------------

case "$SLUG" in
  juris-prime)
    # truecopyattestions.com. Every page is genuine attestation service content
    # — the guides on MOFA vs embassy attestation and required documents are
    # exactly what customers ask on WhatsApp. Only the blog index is dropped, as
    # it is a list of links with no substance of its own.
    SITEMAPS=(
      "https://truecopyattestions.com/page-sitemap.xml"
      "https://truecopyattestions.com/post-sitemap.xml"
    )
    EXCLUDE='/blog/?$'
    ;;

  juris-prime-legal)
    # jurisprimelegal.ae. Real practice-area pages (civil, commercial, family,
    # real estate law, company formation, power of attorney).
    # Dropped: the WooCommerce plumbing this site carries — cart, checkout,
    # shop, my-account — which describe a purchase flow, not a legal service,
    # and would surface as answers about baskets.
    SITEMAPS=(
      "https://jurisprimelegal.ae/page-sitemap.xml"
      "https://jurisprimelegal.ae/post-sitemap.xml"
    )
    EXCLUDE='/(cart|checkout|my-account|shop|blog|blogs|notices)/?$'
    ;;

  sfs-international)
    # sfsintrealestate.com — INFORMATIONAL PAGES ONLY. Individual property
    # listings are deliberately excluded, for two independent reasons:
    #
    # 1. Most of them are unreplaced Houzez theme DEMO data. "Chic urban
    #    studio", "central apartment with doorman", "suburban semi-detached
    #    house", "loft conversion apartment" — none of it is UAE stock. An
    #    agent that indexed those would describe inventory that does not
    #    exist, and cite a real URL while doing it, which is worse than an
    #    ordinary hallucination because it survives a spot check.
    #
    # 2. Even the genuine listings do not belong in a static knowledge base.
    #    Property sells, prices move, availability changes hourly. A 6-hourly
    #    re-index cannot keep a snapshot honest, and the tenant's own system
    #    prompt already forbids stating availability or price that is not in
    #    live context. Listings belong behind a live query — a `search_listings`
    #    tool — not baked into embeddings.
    #
    # Also dropped: the theme's layout demos (grid-*, with-*, list-layout-*),
    # account plumbing, and the stray /testing/ page.
    SITEMAPS=(
      "https://sfsintrealestate.com/page-sitemap.xml"
    )
    # Character classes include digits deliberately: a first pass written as
    # `grid-[a-z-]*` let `grid-full-width-2-cols` through, and the demo city
    # pages are matched by name because their slugs share no prefix with
    # anything else — `apartments-in-new-york` is a New York listing page on a
    # Dubai agency's site, and it is exactly what must never be indexed.
    EXCLUDE='/(property|grid-[a-z0-9-]*|with-[a-z0-9-]*|list-layout[a-z0-9-]*|listings[a-z0-9-]*|home-[a-z0-9-]*|my-[a-z0-9-]*|compare-properties|saved-search|search-results|select-your-package|complete-order|create-listing|favorite-properties|invoices|membership-info|packages|stripe|thank-you|testing|inquiry-form|agents-2|agencies|board|blog)/|new-york|los-angeles|miami|brooklyn'
    ;;

  *)
    echo "No curated source list for '$SLUG'." >&2
    echo "Tenants with lists: juris-prime, juris-prime-legal, sfs-international" >&2
    echo "atif-ali-production is deliberately absent — its website is offline," >&2
    echo "so there is nothing to index until it returns." >&2
    exit 2
    ;;
esac

# ------------------------------------------------------------
# Ingest
# ------------------------------------------------------------

URLS="$(curl -sS -m 30 "${SITEMAPS[@]}" \
  | grep -o '<loc>[^<]*</loc>' \
  | sed 's/.*<loc>//; s|</loc>||' \
  | grep -Ev "$EXCLUDE" \
  | grep -v '\.xml$' \
  | sort -u)"

TOTAL="$(printf '%s\n' "$URLS" | grep -c . || true)"
echo "Ingesting $TOTAL curated pages for $SLUG"
echo

indexed=0
unchanged=0
failed=0

while IFS= read -r url; do
  [[ -z "$url" ]] && continue
  response="$(curl -sS -m 120 -X POST "$API/api/organizations/$SLUG/knowledge" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"$url\"}" || echo '{"error":"request failed"}')"

  chunks="$(printf '%s' "$response" | sed -n 's/.*"chunks":\([0-9]*\).*/\1/p')"
  if printf '%s' "$response" | grep -q '"unchanged":true'; then
    unchanged=$((unchanged + 1))
    printf '  = %-60s unchanged\n' "${url#https://}"
  elif [[ -n "$chunks" ]]; then
    indexed=$((indexed + 1))
    printf '  + %-60s %s chunks\n' "${url#https://}" "$chunks"
  else
    failed=$((failed + 1))
    printf '  ! %-60s %s\n' "${url#https://}" "$response"
  fi

  sleep "$PACE"
done <<< "$URLS"

echo
echo "$SLUG: $indexed indexed, $unchanged already current, $failed failed"

# Assert the outcome rather than reporting a clean exit. A run where every page
# failed still exits 0 from the loop above, and "no errors" is precisely the
# signal this codebase has learned not to trust.
if [[ "$indexed" -eq 0 && "$unchanged" -eq 0 ]]; then
  echo "Nothing was indexed — treat this as a failure, not a no-op." >&2
  exit 1
fi
