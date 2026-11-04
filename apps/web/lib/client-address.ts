import { createHmac } from "node:crypto";
import { sessionSecret } from "@/lib/auth";

/**
 * The browser's address, signed, for the API's sign-in lockout (audit, 4 Nov 2026).
 *
 * The web calls the API server to server, back through Caddy, so the API saw
 * the web server's own address for every person and one lockout covered the
 * whole platform. Caddy sets X-Forwarded-For on the browser's request to the
 * web (and overwrites anything the browser sent), so its first entry is the
 * browser; it is passed on signed with the session secret both sides hold, and
 * the API ignores it unless the signature checks.
 */
export async function clientAddressHeaders(req: Request): Promise<Record<string, string>> {
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!address || address.length > 64) return {};
  const signature = createHmac("sha256", sessionSecret()).update(`nexus-client-address:${address}`).digest("hex");
  return { "x-nexus-client-address": address, "x-nexus-client-signature": signature };
}
