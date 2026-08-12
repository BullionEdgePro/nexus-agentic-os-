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

function clear(res: NextResponse): NextResponse {
  const domain = sessionCookieDomain();

  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    domain,
    maxAge: 0,
  });

  // Belt and braces for sessions issued before SESSION_COOKIE_DOMAIN was set.
  // Those are genuinely host-only, and the delete above — now carrying a
  // Domain — would not match them. Two headers, and nobody is left signed in
  // by a cookie written under the old configuration.
  if (domain) {
    res.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });
  }

  return res;
}

/** Following the link. 303 so the browser lands on `/` with a GET. */
export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  // No-store, or a cached redirect could send somebody to a page the server
  // renders from a session this response just destroyed.
  res.headers.set("Cache-Control", "no-store");
  return clear(res);
}

/** Kept for anything still posting — the API client, and older tabs. */
export async function POST() {
  return clear(NextResponse.json({ ok: true }));
}
