import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, sessionCookieDomain } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Sign out. It was broken in three separate ways at once, and none of them
 * produced an error anybody saw.
 *
 * 1. THE COOKIE WAS NEVER ADDRESSED. A cookie is identified by name, DOMAIN
 *    and path, and can only be expired by a Set-Cookie carrying the same
 *    three. The session is issued WITH a Domain — the browser talks to the app
 *    on one subdomain and the API on a sibling, so a host-only cookie would
 *    never reach the second — and this route cleared it WITHOUT one. That does
 *    not clear anything; it creates a second, host-only cookie of the same
 *    name and expires that. The real session survived.
 *
 * 2. THE RAIL WAS DOING A GET. On every screen except the front page the rail
 *    rendered a plain <a href="/api/auth/logout">, and this route only
 *    exported POST. Nine pages answered 405 Method Not Allowed — a blank error
 *    page, cookie untouched.
 *
 * 3. ON THE FRONT PAGE IT WAS NOT A LINK AT ALL. href={undefined} with an
 *    onClick: clickable with a mouse, invisible to the keyboard.
 *
 * So the design changed rather than the patch. There is now ONE way to sign
 * out — following a link — and it works with JavaScript disabled, from the
 * keyboard, and on every screen. A full navigation also guarantees the server
 * re-renders rather than the client router serving a cached view of a session
 * that no longer exists.
 *
 * The cost of accepting GET is that another site could trigger a sign-out with
 * an <img src>. That is a nuisance, not a breach: it changes no data and
 * discloses nothing. Reliability of the thing people press every day is worth
 * more than defending against being logged out.
 */

/**
 * One expiry header per scope the session could have been written under.
 *
 * WRITTEN BY HAND, and that is the point. `res.cookies.set()` is a Map keyed by
 * NAME — calling it twice for `nexus_session` does not emit two headers, it
 * replaces the first. The previous version set the domain-scoped clear and then
 * the host-only one, so the only header that went out was the host-only one,
 * and production answered:
 *
 *   set-cookie: nexus_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax
 *
 * with no Domain at all, while the live session cookie is scoped to
 * `.nexusagenticos.com`. The fallback added to make sign-out more thorough was
 * deleting the clear that mattered. Sign out returned 200, cleared nothing, and
 * the next page render showed the console again.
 *
 * `headers.append` is the only way to send two Set-Cookie lines, so the
 * attributes are serialised here rather than delegated.
 */
function expire(domain?: string): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    // A date in the past as well as Max-Age: the two are equivalent for every
    // browser in use, but a proxy that rewrites one rarely rewrites both.
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function clear(res: NextResponse): NextResponse {
  const domain = sessionCookieDomain();

  // The scope the cookie is actually written under today.
  res.headers.append("Set-Cookie", expire(domain));

  // And the host-only scope, for sessions issued before SESSION_COOKIE_DOMAIN
  // was configured. Those are genuinely host-only and a Domain-carrying delete
  // does not match them. Skipped when there is no domain, or this would be the
  // same header twice.
  if (domain) res.headers.append("Set-Cookie", expire());

  return res;
}

/**
 * Following the link. 303 so the browser lands on `/` with a GET.
 *
 * The Location is RELATIVE, and deliberately so. `NextResponse.redirect`
 * demands an absolute URL, and the obvious `new URL("/", req.url)` builds one
 * from the origin THIS PROCESS thinks it is serving. Behind the reverse proxy
 * that is the container's own hostname, so production answered
 *   303 -> https://61307059e8b2:3000/
 * which resolves nowhere from a customer's browser. A 303 to a dead host looks
 * exactly like a working sign-out in every log and every test that only checks
 * the status code.
 *
 * A relative Location is legal (RFC 7231 §7.1.2) and the browser resolves it
 * against the address it actually asked for — which is the public one, whatever
 * the proxy is or is not forwarding.
 */
export async function GET(_req: NextRequest) {
  const res = new NextResponse(null, {
    status: 303,
    headers: {
      Location: "/",
      // No-store, or a cached redirect could send somebody to a page the
      // server renders from a session this response just destroyed.
      "Cache-Control": "no-store",
    },
  });
  return clear(res);
}

/** Kept for anything still posting — the API client, and older tabs. */
export async function POST() {
  return clear(NextResponse.json({ ok: true }));
}
