/**
 * Bulk-index a tenant's own website into its knowledge base.
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/ingest-site.ts juris-prime
 *
 * Runs INSIDE the container, against the database and the Gemini key that are
 * already there — the same shape as `npm run migrate`. The alternative was a
 * shell script calling the public API with a bearer token, which would have
 * meant minting a long-lived secret granting unscoped operator access to every
 * tenant's customer data, created solely so a script could reach in from
 * outside. The work happens next to the data; it should not take a round trip
 * through the internet and a standing credential to do it.
 *
 * Why this exists at all: the shared number made three tenants reachable by
 * real customers, each carrying ~11 chunks from 3-4 pages. Thin knowledge does
 * not produce wrong answers — the governance judge catches those — it produces
 * vague ones and constant escalation, which is what an operator actually feels.
 */
import { pathToFileURL } from "node:url";
import { findOrganizationBySlug } from "@nexus/db";
import { ingestUrlSource } from "@nexus/knowledge";

interface TenantSource {
  sitemaps: string[];
  /**
   * URLs listed by hand, for sites with no sitemap.
   *
   * Not every business runs WordPress. abshlaw.com is a single page with no
   * sitemap at all, and a crawler pointed at it would have found nothing and
   * reported a clean run — the failure mode this codebase keeps producing.
   */
  pages?: string[];
  /** Pages matching this are NOT indexed. See each tenant's note. */
  exclude: RegExp;
  note: string;
}

/**
 * Curated, not crawled.
 *
 * What is excluded is the substance of this file. A crawler would have indexed
 * all of it and produced an agent that sounds authoritative about things that
 * are not true.
 */
export const TENANT_SOURCES: Record<string, TenantSource> = {
  "juris-prime": {
    sitemaps: [
      "https://truecopyattestions.com/page-sitemap.xml",
      "https://truecopyattestions.com/post-sitemap.xml",
    ],
    // Only the blog index: a list of links with no substance of its own.
    // Everything else is genuine attestation content — MOFA vs embassy, the
    // documents each attestation needs, educational certificates for UAE jobs —
    // which is exactly what customers ask on WhatsApp.
    exclude: /\/blog\/?$/,
    note: "attestation, notary and legal translation service pages",
  },

  "juris-prime-legal": {
    sitemaps: [
      "https://jurisprimelegal.ae/page-sitemap.xml",
      "https://jurisprimelegal.ae/post-sitemap.xml",
    ],
    // The site carries WooCommerce plumbing. Cart and checkout pages describe a
    // purchase flow, not a legal service, and would surface as answers about
    // baskets when someone asks about a contract dispute.
    exclude: /\/(cart|checkout|my-account|shop|blog|blogs|notices)\/?$/,
    note: "legal practice areas and company formation",
  },

  "sfs-international": {
    sitemaps: ["https://sfsintrealestate.com/page-sitemap.xml"],
    // INFORMATIONAL PAGES ONLY. Individual property listings are excluded for
    // two independent reasons, either of which is sufficient:
    //
    // 1. Most are unreplaced Houzez theme DEMO data — "chic urban studio",
    //    "central apartment with doorman", "suburban semi-detached house", and
    //    an `apartments-in-new-york` page on a Dubai agency's site. An agent
    //    indexing those would describe inventory that does not exist AND cite a
    //    real URL doing it, which survives a spot check in a way an ordinary
    //    hallucination does not.
    //
    // 2. Live listings do not belong in a static knowledge base regardless.
    //    Property sells, prices move, availability changes hourly; a 6-hourly
    //    re-index cannot keep a snapshot honest, and this tenant's own system
    //    prompt already forbids stating availability or price that is not in
    //    live context. Listings want a `search_listings` tool, not embeddings.
    //
    // Character classes include digits deliberately: a first pass written as
    // `grid-[a-z-]*` let `grid-full-width-2-cols` straight through.
    exclude:
      /\/(property|grid-[a-z0-9-]*|with-[a-z0-9-]*|list-layout[a-z0-9-]*|listings[a-z0-9-]*|home-[a-z0-9-]*|my-[a-z0-9-]*|compare-properties|saved-search|search-results|select-your-package|complete-order|create-listing|favorite-properties|invoices|membership-info|packages|stripe|thank-you|testing|inquiry-form|agents-2|agencies|board|blog)\/|new-york|los-angeles|miami|brooklyn/,
    note: "agency information, FAQ and terms — deliberately no property listings",
  },

  abr: {
    // abshlaw.com is a single-page site — the practice areas, team, and contact
    // details all live on `/`, with no sitemap. So the "sitemap" here is the
    // page itself; `extractLocations` finds nothing in HTML, and the fallback
    // below supplies the URL directly.
    sitemaps: [],
    pages: ["https://www.abshlaw.com/"],
    exclude: /$^/, // nothing to exclude from a hand-listed page
    note: "litigation, arbitration and criminal defence practice areas",
  },

  // atif-ali-production was removed from the platform on 2026-08-08 (migration
  // 014) and replaced by ABR. Its entry is gone rather than commented out — a
  // source list for a tenant that no longer exists is a trap for whoever reads
  // this next.
};

/** Pull <loc> entries out of a sitemap. Tolerates index files and stray XML. */
export function extractLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((url) => url && !url.endsWith(".xml"));
}

/**
 * Apply the curation rule.
 *
 * Separated and exported so it can be tested without a network or a database —
 * this is where the only bug so far lived, and it was the silent kind: the
 * filter looked right and let a New York listing through onto a Dubai agency's
 * agent.
 */
export function selectPages(urls: string[], exclude: RegExp): string[] {
  return [...new Set(urls)].filter((url) => !exclude.test(url)).sort();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSitemap(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("usage: tsx apps/api/src/scripts/ingest-site.ts <tenant-slug>");
    console.error(`known: ${Object.keys(TENANT_SOURCES).join(", ")}`);
    process.exit(2);
  }

  const source = TENANT_SOURCES[slug];
  if (!source) {
    console.error(`No curated source list for '${slug}'.`);
    console.error(`known: ${Object.keys(TENANT_SOURCES).join(", ")}`);
    console.error(
      "atif-ali-production is deliberately absent — its website is offline, so there is nothing to index."
    );
    process.exit(2);
  }

  const organization = await findOrganizationBySlug(slug);
  if (!organization) {
    console.error(`No active organization with slug '${slug}'.`);
    process.exit(1);
  }

  const found: string[] = [...(source.pages ?? [])];
  for (const sitemap of source.sitemaps) {
    try {
      found.push(...extractLocations(await fetchSitemap(sitemap)));
    } catch (err) {
      console.error(`  ! could not read ${sitemap}: ${(err as Error).message}`);
    }
  }

  const pages = selectPages(found, source.exclude);
  console.log(`${organization.name} — ${source.note}`);
  console.log(`${found.length} pages in sitemaps, ${pages.length} selected after curation\n`);

  if (pages.length === 0) {
    console.error("Nothing selected. Refusing to report success on an empty run.");
    process.exit(1);
  }

  let indexed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const url of pages) {
    try {
      const result = await ingestUrlSource({ organizationId: organization.id, employeeId: null, url });
      if (result.skipped) {
        unchanged += 1;
        console.log(`  = ${url}  (already current)`);
      } else {
        indexed += 1;
        console.log(`  + ${url}  ${result.chunks} chunks`);
      }
    } catch (err) {
      failed += 1;
      console.log(`  ! ${url}  ${(err as Error).message}`);
    }
    // The Gemini free tier has already returned 429 on this project. One page
    // at a time with a pause is slower than it needs to be and finishes, which
    // a burst does not.
    await sleep(2_000);
  }

  console.log(`\n${slug}: ${indexed} indexed, ${unchanged} already current, ${failed} failed`);

  // Assert the outcome. A run where every page failed still ends the loop
  // normally, and "nothing threw" is the signal this codebase has learned not
  // to trust.
  if (indexed === 0 && unchanged === 0) {
    console.error("Nothing was indexed — treat this as a failure, not a no-op.");
    process.exit(1);
  }
}

/**
 * Only run when invoked directly.
 *
 * The curation rules are exported so they can be tested without a network or a
 * database, and without this guard importing them ran the CLI — which read
 * argv, found no tenant slug, and exited the test process.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Ingestion failed:", err);
      process.exit(1);
    });
}
