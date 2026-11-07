import type { Context, MiddlewareHandler } from "hono";

/**
 * A unit's photo upload, read before the request's database transaction opens
 * (7 Nov 2026, portal listings) — as team chat does: a phone on a slow line
 * would otherwise hold a pooled connection, inside a transaction, for as long
 * as the photo takes to arrive. The body is read in bounded chunks and refused
 * the moment it passes the limit, never buffered whole first.
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2.2
 */

export const PHOTO_MAX_BYTES = 4_194_304; // 4 MB
const REQUEST_MAX = PHOTO_MAX_BYTES + 64 * 1024; // the photo plus the form's own envelope
export const PHOTO_TOO_LARGE = "That photo is over 4 MB.";
const UNREADABLE = "That upload could not be read.";

export type PhotoUpload = { ok: true; file: File | null } | { ok: false; status: 400 | 413; error: string };

const KEY = "boardPhotoUpload";

async function read(c: Context): Promise<PhotoUpload> {
  const declared = c.req.header("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > REQUEST_MAX)) return { ok: false, status: 413, error: PHOTO_TOO_LARGE };
  const body = c.req.raw.body;
  if (!body) return { ok: false, status: 400, error: UNREADABLE };
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REQUEST_MAX) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: PHOTO_TOO_LARGE };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: UNREADABLE };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  try {
    const form = await new Response(bytes, { headers: { "content-type": c.req.header("content-type") ?? "" } }).formData();
    const photo = form.get("photo");
    return { ok: true, file: photo instanceof File ? photo : null };
  } catch {
    return { ok: false, status: 400, error: UNREADABLE };
  }
}

/** The upload, read once per request (by the gate, or by the route when there is no gate). */
export async function readBoardPhoto(c: Context): Promise<PhotoUpload> {
  const cached = c.get(KEY) as PhotoUpload | undefined;
  if (cached) return cached;
  const result = await read(c);
  c.set(KEY, result);
  return result;
}

const isPhotoUpload = (c: Context) =>
  c.req.method === "POST" &&
  /\/workflow-board\/units\/[^/]+\/photos$/.test(c.req.path) &&
  (c.req.header("content-type") ?? "").startsWith("multipart/form-data");

/** Mounted before the tenant context: reads the photo before a transaction is open. */
export const boardPhotoGate: MiddlewareHandler = async (c, next) => {
  if (isPhotoUpload(c)) await readBoardPhoto(c);
  await next();
};
