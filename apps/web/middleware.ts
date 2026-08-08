import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  const { pathname } = req.nextUrl;

  // Guard the command deck AND the Unified Inbox. Both render every tenant's
  // customer conversations — names, WhatsApp numbers, message bodies — and the
  // inbox was once served to anyone who loaded the site.
  //
  // `/` is deliberately NOT in this list. It is the public front page now, so
  // nexusagenticos.com resolves to the site itself instead of bouncing every
  // visitor to a sign-in URL.
  const isProtected = pathname.startsWith("/deck") || pathname.startsWith("/inbox");
  if (isProtected && !session) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.hash = "signin";
    return NextResponse.redirect(url);
  }

  // Already signed in → skip the front page and go straight to work.
  if (pathname === "/" && session) {
    const url = req.nextUrl.clone();
    url.pathname = "/deck";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/deck/:path*", "/inbox/:path*"],
};
