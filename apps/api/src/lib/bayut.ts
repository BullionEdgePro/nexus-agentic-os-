import type { BayutListingBody, BayutPortal } from "@nexus/shared";

/**
 * Bayut's Profolio API (23 Nov 2026) — the only code that knows its addresses.
 *
 * Auth is one bearer token the agency copies from its Profolio dashboard. Every
 * call maps to a plain answer: 401/403 → token-refused, 409 → busy (Bayut is
 * still working on the same listing), 429 → rate-limited (with Bayut's own
 * retry_after, default 60 s), other 4xx → refused (Bayut's own words, with the
 * first error of each field), 5xx / network / 15 s timeout → unreachable.
 *
 * The token never comes back in a message: Bayut may echo the request, so every
 * message that can hold Bayut's text has the token replaced by "•••". Nothing in
 * this file logs.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §2, §10, §14
 */

export const BAYUT_API = "https://api.bayut.com/v1";

type Failure = {
  ok: false;
  kind: "refused" | "unreachable" | "token-refused" | "busy" | "rate-limited";
  message: string;
  retryAfter?: number;
};
export type BayutAnswer<T> = { ok: true; data: T } | Failure;

type Portals = { name: string; state: string }[];

export type BayutClient = {
  agencies(token: string): Promise<BayutAnswer<{ id: number; parentId: number | null; name: string }[]>>;
  users(token: string, agencyId: number): Promise<BayutAnswer<{ id: number; name: string; email: string | null }[]>>;
  amenities(token: string): Promise<BayutAnswer<{ id: string; title: { en: string } }[]>>;
  locations(token: string, q: string, city: string): Promise<BayutAnswer<{ id: number; breadcrumb: string[] }[]>>;
  create(token: string, body: BayutListingBody): Promise<BayutAnswer<{ id: string }>>;
  update(token: string, id: string, body: BayutListingBody): Promise<BayutAnswer<null>>;
  publish(token: string, id: string, portals: BayutPortal[]): Promise<BayutAnswer<null>>;
  remove(token: string, id: string, portals: BayutPortal[]): Promise<BayutAnswer<null>>;
  show(
    token: string,
    id: string,
  ): Promise<BayutAnswer<{ portals: Portals; permit: { status: string | null; comment: string | null } | null }>>;
  list(
    token: string,
    agencyId: number,
    page: number,
  ): Promise<BayutAnswer<{ items: { id: string; portals: Portals }[]; next: boolean }>>;
  rejected(token: string): Promise<BayutAnswer<{ id: string; reason: string }[]>>;
};

const TIMEOUT_MS = 15_000;
const MESSAGE_MAX = 300;
const DEFAULT_RETRY_AFTER = 60;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Bayut's words, with the token blanked out, at most 300 characters. */
function said(text: string, token: string): string {
  const out = token ? text.split(token).join("•••") : text;
  return out.trim().slice(0, MESSAGE_MAX);
}

const endSentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** "<message> <field>: <first error>." — errors is field → string[] (object) or string[][] (permit validate). */
function bodyMessage(text: string, status: number): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return `HTTP ${status}`;
  }
  if (!isObj(body)) return `HTTP ${status}`;
  const message = str(body.message) ?? str(body.error);
  const parts: string[] = [];
  const errors = body.errors;
  if (Array.isArray(errors)) {
    const first = errors.flat().find((e) => typeof e === "string" && e);
    if (typeof first === "string") parts.push(first);
  } else if (isObj(errors)) {
    for (const [field, list] of Object.entries(errors)) {
      const first = Array.isArray(list) ? list.find((e) => typeof e === "string" && e) : str(list);
      if (typeof first === "string") parts.push(`${field}: ${first}`);
    }
  }
  if (!message && parts.length === 0) return `HTTP ${status}`;
  const joined = [message, ...parts].filter(Boolean).join(" ");
  return parts.length ? endSentence(joined) : joined;
}

function retryAfter(text: string): number {
  try {
    const body = JSON.parse(text) as unknown;
    if (isObj(body) && typeof body.retry_after === "number" && body.retry_after > 0) return body.retry_after;
  } catch {
    // not JSON: use the default
  }
  return DEFAULT_RETRY_AFTER;
}

type Sent = { ok: true; json: unknown } | Failure;

export function makeBayutClient(fetchFn: typeof fetch = fetch): BayutClient {
  async function send(token: string, method: string, path: string, body?: unknown): Promise<Sent> {
    let res: Response;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      res = await fetchFn(`${BAYUT_API}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, kind: "unreachable", message: said(err instanceof Error ? err.message : String(err), token) };
    }
    if (res.ok) return { ok: true, json: await res.json().catch(() => null) };
    const text = await res.text().catch(() => "");
    const message = said(bodyMessage(text, res.status), token);
    if (res.status === 401 || res.status === 403) return { ok: false, kind: "token-refused", message };
    if (res.status === 409) return { ok: false, kind: "busy", message };
    if (res.status === 429) return { ok: false, kind: "rate-limited", message, retryAfter: retryAfter(text) };
    if (res.status >= 400 && res.status < 500) return { ok: false, kind: "refused", message };
    return { ok: false, kind: "unreachable", message: `HTTP ${res.status}` };
  }

  /** Send, then read the answer with `read`; a body that cannot be read is "unreachable". */
  async function ask<T>(
    token: string,
    method: string,
    path: string,
    body: unknown,
    read: (json: Json) => T | null,
    unreadable = "Bayut answered in a form Nexus could not read",
  ): Promise<BayutAnswer<T>> {
    const sent = await send(token, method, path, body);
    if (!sent.ok) return sent;
    const data = isObj(sent.json) ? read(sent.json) : null;
    if (data === null) return { ok: false, kind: "unreachable", message: unreadable };
    return { ok: true, data };
  }

  const okNull = async (token: string, method: string, path: string, body?: unknown): Promise<BayutAnswer<null>> => {
    const sent = await send(token, method, path, body);
    return sent.ok ? { ok: true, data: null } : sent;
  };

  const items = (j: Json): Json[] =>
    Array.isArray(j.data) ? j.data.filter(isObj).map((i) => (isObj(i.data) ? i.data : i)) : [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const portalsOf = (v: unknown): Portals =>
    Array.isArray(v)
      ? v.filter(isObj).map((p) => ({ name: String(p.name ?? "").toLowerCase(), state: String(p.state ?? "").toLowerCase() }))
      : [];
  const q = encodeURIComponent;

  return {
    agencies: (token) =>
      ask(token, "GET", "/agencies?per_page=100", undefined, (j) =>
        items(j).flatMap((a) => {
          const id = num(a.id);
          return id === null ? [] : [{ id, parentId: num(a.parent_id), name: str(a.name) ?? "" }];
        }),
      ),
    users: (token, agencyId) =>
      ask(token, "GET", `/users?agency_id=${agencyId}&per_page=100`, undefined, (j) =>
        items(j).flatMap((u) => {
          const id = num(u.id);
          if (id === null) return [];
          const name = isObj(u.name) ? str(u.name.en) : str(u.name);
          const email = isObj(u.contact) ? str(u.contact.email) : null;
          return [{ id, name: name ?? "", email }];
        }),
      ),
    amenities: (token) =>
      ask(token, "GET", "/amenities?per_page=100", undefined, (j) =>
        items(j).flatMap((a) => {
          if (a.id === undefined || a.id === null) return [];
          return [{ id: String(a.id), title: { en: isObj(a.title) ? (str(a.title.en) ?? "") : "" } }];
        }),
      ),
    locations: (token, term, city) =>
      ask(token, "GET", `/locations?title=${q(term)}&level_2=${q(city)}&per_page=10`, undefined, (j) =>
        items(j).flatMap((l) => {
          const id = num(l.id);
          if (id === null) return [];
          const en = isObj(l.breadcrumb) && Array.isArray(l.breadcrumb.en) ? l.breadcrumb.en : [];
          return [{ id, breadcrumb: en.filter((s): s is string => typeof s === "string") }];
        }),
      ),
    create: (token, body) =>
      ask(
        token,
        "POST",
        "/properties",
        body,
        (j) => {
          const id = isObj(j.data) ? j.data.id : undefined;
          return id === undefined || id === null || id === "" ? null : { id: String(id) };
        },
        "Bayut answered without a property id",
      ),
    update: (token, id, body) => okNull(token, "PUT", `/properties/${q(id)}`, body),
    publish: (token, id, portals) => okNull(token, "POST", `/properties/${q(id)}/products/attach`, { portals }),
    remove: (token, id, portals) => okNull(token, "DELETE", `/properties/${q(id)}`, { portals }),
    show: (token, id) =>
      ask(token, "GET", `/properties/${q(id)}`, undefined, (j) => {
        const d = isObj(j.data) ? j.data : {};
        const p = isObj(d.permit) ? d.permit : null;
        return {
          portals: portalsOf(d.portals),
          permit: p ? { status: str(p.status), comment: str(p.comment) } : null,
        };
      }),
    list: (token, agencyId, page) =>
      ask(token, "GET", `/properties?agency_id=${agencyId}&per_page=100&page=${page}`, undefined, (j) => ({
        items: items(j).flatMap((p) =>
          p.id === undefined || p.id === null ? [] : [{ id: String(p.id), portals: portalsOf(p.portals) }],
        ),
        next: isObj(j.links) && typeof j.links.next === "string" && j.links.next !== "",
      })),
    rejected: (token) =>
      ask(token, "GET", "/properties/rejected", undefined, (j) =>
        items(j).flatMap((r) => {
          const pd = isObj(r.property_details) ? r.property_details : null;
          if (!pd || pd.id === undefined || pd.id === null) return [];
          const vd = isObj(r.validation_details) ? r.validation_details : {};
          return [{ id: String(pd.id), reason: str(vd.description_en) ?? str(vd.category) ?? "" }];
        }),
      ),
  };
}

export const bayutClient: BayutClient = makeBayutClient();
