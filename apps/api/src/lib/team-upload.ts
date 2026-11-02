import type { Context, MiddlewareHandler } from "hono";
import { TEAM_LIMITS } from "./team-files.js";

/**
 * A team chat upload is read in full BEFORE anything touches the database
 * (2 Nov 2026, final review of the WhatsApp-style staff chat).
 *
 * Every /api/* request runs inside a tenant context that checks a connection
 * out of the pool and opens a transaction before the handler starts. Reading a
 * 16 MB photo or voice note inside that context would hold one of the pool's
 * connections for as long as the phone takes to send it — tens of seconds on a
 * weak signal — and a handful of uploads at once would leave every other
 * request, the WhatsApp webhook included, waiting for a connection. So this
 * gate is mounted ahead of the tenant context: the body arrives first, then the
 * request takes a connection for the few milliseconds its writes need.
 *
 * The bytes are COUNTED as they arrive, not trusted from a header: a proxy may
 * forward the upload without a Content-Length, and a declared length can lie.
 * Over the limit, reading stops and the answer is 413.
 */

export type UploadRead =
  | { ok: true; form: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

const KEY = "teamUpload";
const TOO_LARGE = "That upload is too large. Files can be up to 16 MB.";

async function read(c: Context): Promise<UploadRead> {
  const declared = c.req.header("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > TEAM_LIMITS.requestBytes)) {
    return { ok: false, status: 413, error: TOO_LARGE };
  }
  const body = c.req.raw.body;
  if (!body) return { ok: false, status: 400, error: "That upload could not be read." };

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TEAM_LIMITS.requestBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: TOO_LARGE };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "That upload could not be read." };
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  try {
    const form = await new Response(bytes, {
      headers: { "content-type": c.req.header("content-type") ?? "" },
    }).formData();
    const fields: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) fields[key] = value;
    return { ok: true, form: fields };
  } catch {
    return { ok: false, status: 400, error: "That upload could not be read." };
  }
}

/** The upload of this request, read once and kept on the request. */
export async function readTeamUpload(c: Context): Promise<UploadRead> {
  const cached = c.get(KEY) as UploadRead | undefined;
  if (cached) return cached;
  const result = await read(c);
  c.set(KEY, result);
  return result;
}

const isTeamUpload = (c: Context) =>
  c.req.method === "POST" &&
  /\/threads\/[^/]+\/messages$/.test(c.req.path) &&
  (c.req.header("content-type") ?? "").startsWith("multipart/form-data");

/** Mounted before the tenant context: reads a team chat upload while no connection is held. */
export const teamUploadGate: MiddlewareHandler = async (c, next) => {
  if (isTeamUpload(c)) await readTeamUpload(c);
  await next();
};
