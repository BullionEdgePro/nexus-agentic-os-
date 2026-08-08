import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  const { pathname } = req.nextUrl;

  // `/` is never redirected, in either direction. It is the single front door:
  // the page itself decides whether to show the pitch or the console based on
  // the same session, on the server, before anything is sent. A redirect here
  // is what produced two landing pages in the first place — one URL for
  // visitors, another for operators.
  if (pathname === "/") return NextResponse.next();

  // The remaining screens render tenant data — customer names, WhatsApp
  // numbers, message bodies — so they stay behind the session, and an
  // unauthenticated visitor is sent to the sign-in section of the front page
  // rather than to a separate login URL.
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.hash = "signin";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/deck/:path*", "/inbox/:path*"],
};
