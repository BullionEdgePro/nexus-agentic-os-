import { promises as dns } from "node:dns";
import tls from "node:tls";
import { recordHqCheck, HQ_CHECK_KINDS, type HqCheckKind } from "@nexus/db";
import { normalizeBusinessHost, detectProvider, isPrivateAddress } from "@nexus/shared";

/**
 * Business HQ's automatic checks (spec 2026-10-14-business-hq-design.md §3.2, §7).
 *
 * Seven independent checks of one business's website. Each has its own timeout
 * and its own failure, so one slow host never empties the rest, and a check
 * that cannot answer records ok:null ("could not check") rather than a pass.
 *
 * Only the business's own validated hostname and two fixed services (rdap.org,
 * Google PageSpeed) are ever fetched, and redirects are followed by hand so a
 * homepage that redirects into the server's own network is refused, not
 * followed.
 */
export interface HqCheckResult {
  ok: boolean | null;
  data: Record<string, unknown>;
  error: string | null;
}

export interface HqCheckDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  resolveNs: (domain: string) => Promise<string[]>;
  resolve4: (host: string) => Promise<string[]>;
  reverse: (ip: string) => Promise<string[]>;
  /** Every address a name resolves to — what a connection would actually reach. */
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Connect to the vetted address, presenting the hostname for SNI. */
  tlsValidTo: (host: string, address: string) => Promise<{ validTo: string; issuer: string | null }>;
  record: (row: { organizationId: string; kind: HqCheckKind; ok: boolean | null; data: unknown; error: string | null }) => Promise<void>;
}

const TIMEOUT_MS = 10_000;
const SPEED_TIMEOUT_MS = 60_000;
const MAX_HTML = 1_500_000;

// ---------- parsers ----------

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();

function metaContent(html: string, attr: "name" | "rel", value: string, contentAttr: "content" | "href"): string | null {
  const tag = html.match(new RegExp(`<(?:meta|link)\\b[^>]*\\b${attr}=["']${value}["'][^>]*>`, "i"))?.[0];
  if (!tag) return null;
  const v = tag.match(new RegExp(`\\b${contentAttr}=["']([^"']*)["']`, "i"))?.[1];
  const clean = v ? decode(v) : "";
  return clean || null;
}

export function parseSeoSignals(html: string): {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  h1Count: number;
  noindex: boolean;
  canonical: string | null;
  jsonLd: boolean;
} {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const title = decode(rawTitle) || null;
  const robots = metaContent(html, "name", "robots", "content") ?? "";
  return {
    title,
    titleLength: title?.length ?? 0,
    metaDescription: metaContent(html, "name", "description", "content"),
    h1Count: (html.match(/<h1[\s>]/gi) ?? []).length,
    noindex: /noindex/i.test(robots),
    canonical: metaContent(html, "rel", "canonical", "href"),
    jsonLd: /<script[^>]+type=["']application\/ld\+json["']/i.test(html),
  };
}

export function detectPlatform(html: string, headers: Record<string, string>): string | null {
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (h["x-shopid"] || /cdn\.shopify\.com/i.test(html)) return "Shopify";
  if (/wp-content|wp-includes|content=["']WordPress/i.test(html)) return "WordPress";
  if (h["x-wix-request-id"] || /static\.wixstatic\.com/i.test(html)) return "Wix";
  if (/squarespace/i.test(html)) return "Squarespace";
  if (/webflow/i.test(html)) return "Webflow";
  if (/__NEXT_DATA__|\/_next\//.test(html)) return "Next.js";
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRdap(json: any): { registrar: string | null; expiresAt: string | null } {
  const events: { eventAction?: string; eventDate?: string }[] = Array.isArray(json?.events) ? json.events : [];
  const expiry = events.find((e) => e.eventAction === "expiration")?.eventDate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registrar = (Array.isArray(json?.entities) ? json.entities : []).find((e: any) => e?.roles?.includes("registrar"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = registrar?.vcardArray?.[1]?.find?.((f: any) => f?.[0] === "fn")?.[3];
  return {
    registrar: typeof fn === "string" && fn.trim() ? fn.trim() : null,
    expiresAt: expiry && !Number.isNaN(Date.parse(expiry)) ? new Date(expiry).toISOString() : null,
  };
}

function robotsBlocksAll(text: string): boolean {
  let inStar = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(field ?? "")) inStar = value === "*";
    else if (inStar && /^disallow$/i.test(field ?? "") && value === "/") return true;
  }
  return false;
}

// ---------- the network, guarded ----------

const realDeps: HqCheckDeps = {
  fetch: (url, init) => fetch(url, init),
  resolveNs: (d) => dns.resolveNs(d),
  resolve4: (h) => dns.resolve4(h),
  reverse: (ip) => dns.reverse(ip),
  lookup: (host) => dns.lookup(host, { all: true, verbatim: true }),
  tlsValidTo: (host, address) =>
    new Promise((resolve, reject) => {
      const socket = tls.connect({ host: address, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert?.valid_to) return reject(new Error("no certificate"));
        const issuer = (cert.issuer as { O?: string; CN?: string } | undefined)?.O ?? (cert.issuer as { CN?: string } | undefined)?.CN ?? null;
        resolve({ validTo: new Date(cert.valid_to).toISOString(), issuer });
      });
      socket.on("timeout", () => socket.destroy(new Error("TLS handshake timed out")));
      socket.on("error", reject);
    }),
  record: (row) => recordHqCheck({ organizationId: row.organizationId, kind: row.kind, ok: row.ok, data: row.data, error: row.error }),
};

/**
 * Resolve a name and refuse it when ANY address it resolves to is internal.
 * The spelling check (normalizeBusinessHost) cannot see that
 * 169.254.169.254.nip.io, or a rebinding record, points inside the server's
 * own network; this can (final review, 14 Oct 2026).
 */
async function publicAddress(deps: HqCheckDeps, host: string): Promise<string> {
  const addresses = await deps.lookup(host);
  if (!addresses.length) throw new Error(`${host} did not resolve`);
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`refused ${host}: it resolves to a private address`);
  return addresses[0].address;
}

/**
 * GET a page of the business's own site, following redirects by hand: each hop
 * must still be a public hostname that resolves only to public addresses, or
 * the chain stops. Never more than 5 hops.
 */
async function safeGet(deps: HqCheckDeps, url: string, timeoutMs = TIMEOUT_MS): Promise<{ res: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await publicAddress(deps, new URL(current).hostname);
    const res = await deps.fetch(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "NexusBusinessHQ/1.0 (+https://nexusagenticos.com)" } });
    if (res.status < 300 || res.status >= 400) return { res, finalUrl: current };
    const location = res.headers.get("location");
    if (!location) return { res, finalUrl: current };
    const next = new URL(location, current).toString();
    if (!normalizeBusinessHost(next)) throw new Error(`refused a redirect to ${new URL(next).host} (not a public website address)`);
    current = next;
  }
  throw new Error("too many redirects");
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// ---------- the runner ----------

export async function runHqChecks(
  org: { id: string; websiteUrl: string | null },
  overrides: Partial<HqCheckDeps> = {}
): Promise<Record<HqCheckKind, HqCheckResult>> {
  const deps: HqCheckDeps = { ...realDeps, ...overrides };
  const target = normalizeBusinessHost(org.websiteUrl ?? "");
  const results = {} as Record<HqCheckKind, HqCheckResult>;

  if (!target) {
    for (const kind of HQ_CHECK_KINDS) results[kind] = { ok: null, data: {}, error: "Not a public website address" };
  } else {
    const { host, registrable } = target;
    const base = `https://${host}`;

    // The homepage first: http, seo and platform all read it.
    let html = "";
    let headers: Record<string, string> = {};
    const started = Date.now();
    try {
      const { res } = await safeGet(deps, `${base}/`);
      headers = Object.fromEntries(res.headers.entries());
      html = (await res.text()).slice(0, MAX_HTML);
      results.http = res.ok
        ? { ok: true, data: { status: res.status, ms: Date.now() - started }, error: null }
        : { ok: false, data: { status: res.status, ms: Date.now() - started }, error: `HTTP ${res.status}` };
    } catch (err) {
      results.http = { ok: false, data: {}, error: /redirect|private address/i.test(message(err)) ? message(err) : `No answer: ${message(err)}` };
    }

    const branches: [HqCheckKind, () => Promise<HqCheckResult>][] = [
      ["rdap", async () => {
        const res = await deps.fetch(`https://rdap.org/domain/${registrable}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const tld = registrable.slice(registrable.lastIndexOf("."));
        if (!res.ok) return { ok: null, data: {}, error: `No RDAP answer for ${tld} domains (HTTP ${res.status}); enter the expiry by hand` };
        const parsed = parseRdap(await res.json());
        return parsed.expiresAt
          ? { ok: true, data: parsed, error: null }
          : { ok: null, data: parsed, error: `RDAP gave no expiry date for ${tld}` };
      }],
      ["dns", async () => {
        const [nameservers, ips] = await Promise.all([deps.resolveNs(registrable).catch(() => []), deps.resolve4(host).catch(() => [])]);
        const ip = ips[0] ?? null;
        const ptr = ip ? ((await deps.reverse(ip).catch(() => []))[0] ?? null) : null;
        if (!nameservers.length && !ip) return { ok: null, data: {}, error: "The domain did not resolve" };
        return { ok: true, data: { nameservers, ip, ptr, ...detectProvider({ nameservers, ip, ptr, headers }) }, error: null };
      }],
      ["tls", async () => {
        const cert = await deps.tlsValidTo(host, await publicAddress(deps, host));
        return { ok: true, data: cert, error: null };
      }],
      ["speed", async () => {
        const score = async (strategy: "mobile" | "desktop") => {
          const key = process.env.PAGESPEED_API_KEY ? `&key=${encodeURIComponent(process.env.PAGESPEED_API_KEY)}` : "";
          const res = await deps.fetch(
            `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(`${base}/`)}&strategy=${strategy}&category=performance${key}`,
            { signal: AbortSignal.timeout(SPEED_TIMEOUT_MS) }
          );
          if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = ((await res.json()) as any)?.lighthouseResult?.categories?.performance?.score;
          if (typeof s !== "number") throw new Error("PageSpeed returned no score");
          return Math.round(s * 100);
        };
        try {
          const [mobile, desktop] = await Promise.all([score("mobile"), score("desktop")]);
          return { ok: true, data: { mobile, desktop }, error: null };
        } catch (err) {
          return { ok: null, data: {}, error: message(err) };
        }
      }],
      ["seo", async () => {
        if (!html) return { ok: null, data: {}, error: "The homepage could not be read" };
        const signals = parseSeoSignals(html);
        const [robots, sitemap] = await Promise.all([
          safeGet(deps, `${base}/robots.txt`).then(async ({ res }) => ({ ok: res.ok, text: res.ok ? await res.text() : "" })).catch(() => ({ ok: false, text: "" })),
          safeGet(deps, `${base}/sitemap.xml`).then(async ({ res }) => res.ok && /<(urlset|sitemapindex)/i.test(await res.text())).catch(() => false),
        ]);
        return {
          ok: true,
          data: { ...signals, robotsOk: robots.ok, robotsBlocksAll: robots.ok && robotsBlocksAll(robots.text), sitemapOk: sitemap },
          error: null,
        };
      }],
      ["platform", async () => {
        if (!html) return { ok: null, data: {}, error: "The homepage could not be read" };
        return { ok: true, data: { platform: detectPlatform(html, headers) }, error: null };
      }],
    ];

    const settled = await Promise.allSettled(branches.map(([, run]) => run()));
    settled.forEach((outcome, i) => {
      const kind = branches[i][0];
      results[kind] =
        outcome.status === "fulfilled"
          ? outcome.value
          : kind === "tls"
            ? { ok: false, data: {}, error: message(outcome.reason) }
            : { ok: null, data: {}, error: message(outcome.reason) };
    });
  }

  for (const kind of HQ_CHECK_KINDS) {
    const r = results[kind];
    await deps.record({ organizationId: org.id, kind, ok: r.ok, data: r.data, error: r.error }).catch(() => undefined);
  }
  return results;
}
