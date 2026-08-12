import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieDomain } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Sign out — and the reason it did not work.
 *
 * A cookie is identified by name, DOMAIN and path. It can only be replaced or
 * expired by a Set-Cookie carrying the same three.
 *
 * The session is issued with an explicit Domain, because the browser talks to
 * the app on one subdomain and the API on a sibling (app.nexusagenticos.com →
 * api.nexusagenticos.com) and a host-only cookie would never travel to the
 * second. This route cleared it WITHOUT that Domain — which does not clear
 * anything. It sets a second, host-only cookie of the same name and expires
 * that one. The real session was untouched, so the refresh that followed
 * rendered the console again and Sign out looked like a button doing nothing.
 *
 * Nothing errored, no request failed, and the only symptom was still being
 * signed in. Every attribute below now mirrors how the cookie was written.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
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
  // Domain — would not match them. Clearing both costs one header and means
  // nobody is left signed in by a cookie written under the old configuration.
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
