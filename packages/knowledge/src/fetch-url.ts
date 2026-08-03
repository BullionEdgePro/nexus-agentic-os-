import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { htmlToText, extractTitle } from "./html.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000; // 2 MB of HTML is far more than any page of prose
const MAX_REDIRECTS = 3;

export interface FetchedDocument {
  url: string;
  title: string | null;
  text: string;
}

export class UnsafeUrlError extends Error {}

/**
 * Reject addresses that are not routable on the public internet.
 *
 * The worker runs inside Docker on a VPS, so "fetch this URL" is reachable to
 * postgres:5432, redis:6379, the API itself, and the cloud metadata endpoint at
 * 169.254.169.254. Knowledge sources are tenant-supplied, which makes an
 * unguarded fetcher a server-side request forgery primitive that reads internal
 * services and writes the result into a searchable knowledge base.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10) return true; // loopback, this-network, private
    if (a === 169 && b === 254) return true; // link-local — includes cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }

  if (family === 6) {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
    if (normalized === "::1" || normalized === "::") return true;
    if (/^f[cd]/.test(normalized)) return true; // unique local
    if (/^fe[89ab]/.test(normalized)) return true; // link-local
    // IPv4-mapped (::ffff:10.0.0.1) must be judged on the embedded address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  return true; // not an IP literal at all — caller resolves first
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Unsupported protocol: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Docker service names ("postgres", "redis") have no dot and resolve only on
  // the internal network — never a legitimate knowledge source.
  if (!host.includes(".") && isIP(host) === 0) {
    throw new UnsafeUrlError(`Refusing to fetch internal hostname: ${host}`);
  }

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError(`Refusing to fetch private address: ${host}`);
    return url;
  }

  // Resolve and check every address the name maps to — a hostname that
  // resolves to a private IP is the standard way to smuggle SSRF past a
  // string-based allowlist.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve host: ${host}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`Host resolved to no addresses: ${host}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new UnsafeUrlError(`Host ${host} resolves to a private address (${address})`);
    }
  }

  return url;
}

/**
 * Fetch a public web page and return its readable text.
 *
 * Redirects are followed manually so each hop is re-validated — following them
 * automatically would let a public URL redirect straight to an internal one,
 * defeating the check entirely.
 */
export async function fetchDocument(rawUrl: string): Promise<FetchedDocument> {
  let current = await assertPublicUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "NexusAgenticOS-KnowledgeIngest/1.0", accept: "text/html,text/plain" },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect with no location (HTTP ${response.status})`);
        current = await assertPublicUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${current.hostname}`);

      const contentType = response.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
        throw new Error(`Unsupported content-type "${contentType || "unknown"}"`);
      }

      const body = await readCapped(response, MAX_BYTES);
      const isHtml = /html|xhtml/i.test(contentType);

      return {
        url: current.toString(),
        title: isHtml ? extractTitle(body) : null,
        text: isHtml ? htmlToText(body) : body.trim(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Too many redirects fetching ${rawUrl}`);
}

/**
 * Read the body but stop at a byte ceiling.
 *
 * response.text() would happily buffer a multi-gigabyte response into a 4 GB
 * VPS — the size limit has to be enforced while streaming, not after.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      out += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (received - maxBytes))));
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}
