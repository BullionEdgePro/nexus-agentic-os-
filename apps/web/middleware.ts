import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  verifySession,
  signSession,
  needsRenewal,
  claimsOf,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  const { pathname } = req.nextUrl;

  // `/` is never redirected, in either direction. It is the single front door:
  // the page itself decides whether to show the pitch or the console based on
  // the same session, on the server, before anything is sent. A redirect here
  // is what produced two landing pages in the first place — one URL for
  // visitors, another for operators.
  if (pathname === "/") return renewed(NextResponse.next(), session);

  // The remaining screens render tenant data — customer names, WhatsApp
  // numbers, message bodies — so they stay behind the session, and an
  // unauthenticated visitor is sent to the sign-in section of the front page
  // rather than to a separate login URL.
  //
  // With where they were going (5 Nov 2026), so signing in takes them straight
  // back to it rather than to the front of the console.
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("next", pathname + req.nextUrl.search);
    url.hash = "signin";
    return NextResponse.redirect(url);
  }

  return renewed(NextResponse.next(), session);
}

/**
 * A kept sign-in is renewed for another 30 days whenever its person opens a
 * screen more than a day after it was last signed (5 Nov 2026) — so someone who
 * uses Nexus at least once a month never sees the sign-in again on that device.
 * Same person, same business, same cookie scope; only the times move.
 */
async function renewed(
  response: NextResponse,
  session: Awaited<ReturnType<typeof verifySession>>
): Promise<NextResponse> {
  if (!session || !needsRenewal(session)) return response;
  const token = await signSession(session.sub, claimsOf(session), { remember: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(true));
  return response;
}

export const config = {
  matcher: ["/", "/deck/:path*", "/inbox/:path*"],
};
