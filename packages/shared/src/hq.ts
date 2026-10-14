/**
 * Business HQ rules (spec 2026-10-14-business-hq-design.md §4).
 *
 * Pure: the API gathers the state, these decide what is wrong, how bad it is,
 * and what the score is. A check that could not run is reported as "could not
 * check", never as passing — the one thing a health screen must not do is turn
 * green because it failed to look.
 */
export type HqSeverity = "critical" | "warning" | "notice";

export interface HqIssue {
  code: string;
  severity: HqSeverity;
  title: string;
  fix: string;
}

export type HqCheckKindName = "rdap" | "dns" | "tls" | "http" | "speed" | "seo" | "platform";

export interface HqCheckState {
  ok: boolean | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error: string | null;
  ranAt: string;
}

export interface HqState {
  checks: Partial<Record<HqCheckKindName, HqCheckState>>;
  profile: { gbpUrl?: string | null; gbpLastPostAt?: string | null; gbpLastPhotoAt?: string | null } | null;
  keywords: { keyword: string; checkedAt: string | null }[];
  socials: { platform: string; handle: string | null; lastPostAt: string | null; twoFactor: boolean | null }[];
  vault: { service: string; label: string | null; hasSecret: boolean; secretChangedAt: string | null }[];
}

const PENALTY: Record<HqSeverity, number> = { critical: 25, warning: 10, notice: 3 };

export function scoreHealth(issues: HqIssue[]): number {
  return Math.max(0, 100 - issues.reduce((sum, issue) => sum + PENALTY[issue.severity], 0));
}

const DAY = 86_400_000;
const daysUntil = (iso: string, now: Date) => Math.round((new Date(iso).getTime() - now.getTime()) / DAY);
const daysSince = (iso: string, now: Date) => Math.round((now.getTime() - new Date(iso).getTime()) / DAY);

export function staleness(lastAt: string | null, maxDays: number, now: Date): "fresh" | "stale" | "never" {
  if (!lastAt) return "never";
  return daysSince(lastAt, now) > maxDays ? "stale" : "fresh";
}

const CHECK_NAMES: Record<HqCheckKindName, string> = {
  rdap: "domain expiry",
  dns: "who hosts the site",
  tls: "the SSL certificate",
  http: "whether the site is up",
  speed: "the speed score",
  seo: "the SEO basics",
  platform: "the website platform",
};

const PLATFORM_NAMES: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  x: "X",
  snapchat: "Snapchat",
  google_business: "Google Business",
  other: "Account",
};

export function hqIssues(state: HqState, now: Date): HqIssue[] {
  const issues: HqIssue[] = [];
  const add = (code: string, severity: HqSeverity, title: string, fix: string) => issues.push({ code, severity, title, fix });
  const c = state.checks;

  // Anything that did not run, or ran and could not answer, is said out loud.
  for (const kind of Object.keys(CHECK_NAMES) as HqCheckKindName[]) {
    const check = c[kind];
    const unanswered = !check || check.ok === null || (check.ok === false && kind !== "http" && kind !== "tls");
    if (unanswered) {
      add(`unknown-${kind}`, "notice", `Could not check ${CHECK_NAMES[kind]}`, check?.error ? `Last attempt: ${check.error}` : "Press Check now, or wait for the 6 am run.");
    }
  }

  if (c.http?.ok === false) add("site-down", "critical", "Site is down", c.http.error ? `The homepage answered: ${c.http.error}. Check the hosting.` : "The homepage did not answer. Check the hosting.");

  if (c.tls?.ok === false) {
    add("ssl-broken", "critical", "SSL certificate is not working", "Visitors see a security warning. Renew or reinstall the certificate at the host.");
  } else if (c.tls?.ok && c.tls.data?.validTo) {
    const d = daysUntil(c.tls.data.validTo, now);
    if (d <= 0) add("ssl-expired", "critical", "SSL certificate has expired", "Renew it at the host today; browsers are warning visitors away.");
    else if (d <= 7) add("ssl-expiring", "critical", `SSL expires in ${d} days`, "Renew the certificate at the host now.");
    else if (d <= 21) add("ssl-expiring", "warning", `SSL expires in ${d} days`, "Check that auto-renew is on at the host.");
  }

  if (c.rdap?.ok && c.rdap.data?.expiresAt) {
    const d = daysUntil(c.rdap.data.expiresAt, now);
    if (d <= 0) add("domain-expired", "critical", "Domain has expired", "Renew it at the registrar today, before someone else can register it.");
    else if (d <= 14) add("domain-expiring", "critical", `Domain expires in ${d} days`, "Renew it at the registrar now.");
    else if (d <= 30) add("domain-expiring", "warning", `Domain expires in ${d} days`, "Renew it, or check that auto-renew is on.");
  }

  const mobile = c.speed?.ok ? c.speed.data?.mobile : null;
  if (typeof mobile === "number") {
    if (mobile < 50) add("slow-mobile", "warning", `Mobile speed score is ${mobile}`, "Compress images and remove unused plugins or scripts.");
    else if (mobile < 70) add("slow-mobile", "notice", `Mobile speed score is ${mobile}`, "Compress large images to get above 70.");
  }

  const seo = c.seo?.ok ? c.seo.data : null;
  if (seo) {
    if (!seo.title) add("seo-title", "warning", "Homepage has no title", "Add a title of 50–60 characters with the business name and service.");
    if (!seo.metaDescription) add("seo-description", "warning", "Homepage has no meta description", "Add a 150–160 character description; it is what Google shows under the title.");
    if (!seo.sitemapOk) add("seo-sitemap", "warning", "No sitemap.xml", "Publish a sitemap and submit it in Google Search Console.");
    if (seo.robotsBlocksAll) add("seo-robots", "warning", "robots.txt blocks search engines", "Remove the Disallow: / line so Google can crawl the site.");
    if (seo.noindex) add("seo-noindex", "warning", "The homepage tells Google not to index it", "Remove the noindex tag, or the site cannot appear in search.");
    if (!seo.jsonLd) add("seo-schema", "notice", "No structured data", "Add LocalBusiness structured data so Google shows the address and hours.");
    if (seo.h1Count === 0) add("seo-h1", "notice", "No main heading (H1)", "Give the homepage one H1 naming what the business does.");
    if (!seo.canonical) add("seo-canonical", "notice", "No canonical tag", "Add a canonical link so Google indexes one version of each page.");
  }

  const profile = state.profile;
  if (profile?.gbpUrl) {
    if (!profile.gbpLastPostAt) add("gbp-post", "notice", "Google Business Profile: no post recorded", "Post an update weekly; it keeps the profile ranking.");
    else if (staleness(profile.gbpLastPostAt, 7, now) === "stale")
      add("gbp-post", "notice", `Google Business Profile: no post in ${daysSince(profile.gbpLastPostAt, now)} days`, "Post an update; weekly is the rhythm Google rewards.");
    if (profile.gbpLastPhotoAt && staleness(profile.gbpLastPhotoAt, 30, now) === "stale")
      add("gbp-photo", "notice", `Google Business Profile: no new photo in ${daysSince(profile.gbpLastPhotoAt, now)} days`, "Add a recent photo of the office, team or work.");
  }

  for (const k of state.keywords) {
    if (!k.checkedAt) add(`keyword-${k.keyword}`, "notice", `Keyword "${k.keyword}" never checked`, "Search it on Google and record the position.");
    else if (staleness(k.checkedAt, 30, now) === "stale")
      add(`keyword-${k.keyword}`, "notice", `Keyword "${k.keyword}" not checked in ${daysSince(k.checkedAt, now)} days`, "Search it on Google and record the position.");
  }

  for (const s of state.socials) {
    const name = `${PLATFORM_NAMES[s.platform] ?? s.platform}${s.handle ? ` ${s.handle}` : ""}`;
    if (s.twoFactor === false) add(`social-2fa-${s.platform}-${s.handle}`, "notice", `${name} has no two-factor sign-in`, "Turn on two-factor in the account's security settings.");
    if (s.lastPostAt && staleness(s.lastPostAt, 14, now) === "stale")
      add(`social-post-${s.platform}-${s.handle}`, "notice", `${name}: no post in ${daysSince(s.lastPostAt, now)} days`, "Post something; an idle page looks closed.");
  }

  for (const v of state.vault) {
    if (v.hasSecret && v.secretChangedAt && staleness(v.secretChangedAt, 180, now) === "stale") {
      const name = v.label ? `${v.service} (${v.label})` : v.service;
      add(`vault-age-${name}`, "notice", `${name} password unchanged for ${daysSince(v.secretChangedAt, now)} days`, "Change it at the service, then update it here.");
    }
  }

  const order: Record<HqSeverity, number> = { critical: 0, warning: 1, notice: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------- the address that gets checked ----------

const INTERNAL_SUFFIX = /\.(local|internal|localhost|lan|home|corp|intranet)$/i;
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);

/**
 * The public hostname to check, and the registrable domain to look up.
 *
 * Only a real public name gets fetched: an IP, a port, localhost, a single-label
 * name or an internal suffix is refused, so a website field can never make the
 * server fetch something inside its own network.
 */
export function normalizeBusinessHost(websiteUrl: string): { host: string; registrable: string } | null {
  const raw = (websiteUrl ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || !host.includes(".")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (INTERNAL_SUFFIX.test(host)) return null;
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  const keep = tld.length === 2 && labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  return { host, registrable: labels.slice(-keep).join(".") };
}

// ---------- who hosts it ----------

const NAMESERVER_PROVIDERS: [RegExp, string][] = [
  [/dns-parking\.com$|hostinger/i, "Hostinger"],
  [/domaincontrol\.com$/i, "GoDaddy"],
  [/wixdns\.net$/i, "Wix"],
  [/squarespacedns\.com$/i, "Squarespace"],
  [/awsdns/i, "AWS"],
  [/googledomains\.com$|ns-cloud-.*\.googledomains/i, "Google"],
  [/vercel-dns\.com$/i, "Vercel"],
  [/shopify/i, "Shopify"],
];

const PTR_PROVIDERS: [RegExp, string][] = [
  [/myshopify\.com$|shopify/i, "Shopify"],
  [/vercel/i, "Vercel"],
  [/hostinger|hstgr/i, "Hostinger"],
  [/amazonaws\.com$/i, "AWS"],
  [/googleusercontent\.com$|1e100\.net$/i, "Google Cloud"],
  [/secureserver\.net$/i, "GoDaddy"],
];

export function detectProvider(input: {
  nameservers: string[];
  ip: string | null;
  ptr: string | null;
  headers: Record<string, string>;
}): { provider: string; behindProxy: boolean } {
  const h = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  // Shopify first: Shopify itself sits behind Cloudflare, and "Shopify" is the
  // useful answer (Zipicka read "Behind Cloudflare" on the first live run).
  if (h["x-shopid"] || h["x-shopify-stage"] || /myshopify\.com$|shopify/i.test(input.ptr ?? "")) return { provider: "Shopify", behindProxy: false };
  // Cloudflare's proxy answers for the site, so its IP says nothing about the
  // real host. Say that, rather than name Cloudflare as the host.
  if ((h.server ?? "").toLowerCase() === "cloudflare" || h["cf-ray"]) {
    return { provider: "Behind Cloudflare (real host hidden)", behindProxy: true };
  }
  if (h["x-shopid"] || h["x-shopify-stage"]) return { provider: "Shopify", behindProxy: false };
  if (h["x-vercel-id"]) return { provider: "Vercel", behindProxy: false };
  const ptr = input.ptr?.toLowerCase() ?? null;
  if (ptr) {
    for (const [pattern, name] of PTR_PROVIDERS) if (pattern.test(ptr)) return { provider: name, behindProxy: false };
  }
  for (const ns of input.nameservers ?? []) {
    for (const [pattern, name] of NAMESERVER_PROVIDERS) if (pattern.test(ns)) return { provider: name, behindProxy: false };
  }
  if (ptr) return { provider: ptr, behindProxy: false };
  if (input.ip) return { provider: input.ip, behindProxy: false };
  return { provider: "Unknown", behindProxy: false };
}

// ---------- addresses and links (final review, 14 Oct 2026) ----------

/**
 * Is this IP address one the server must never be made to fetch? Private,
 * loopback, link-local (cloud metadata lives at 169.254.169.254), CGNAT,
 * "this network", and the IPv6 equivalents, including IPv4-mapped forms.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (addr === "::" || addr === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true; // fe80::/10 link-local
  return false;
}

/**
 * A link a person may click: http or https only, so a stored `javascript:` or
 * `data:` URL can never become an href beside an unlocked vault. A bare
 * "example.com" is read as https. Anything else is refused (null).
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, raw.endsWith("/") ? "/" : "") : null;
  } catch {
    return null;
  }
}
