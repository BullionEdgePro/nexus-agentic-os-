import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  const { pathname } = req.nextUrl;

  // Guard the command deck AND the Unified Inbox. The inbox renders every
  // tenant's customer conversations — names, WhatsApp numbers, message bodies —
  // and was previously served to anyone who loaded the site.
  const isProtected = pathname === "/" || pathname.startsWith("/deck");
  if (isProtected && !session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Already signed in → skip the login screen.
  if (pathname === "/login" && session) {
    const url = req.nextUrl.clone();
    url.pathname = "/deck";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/deck/:path*", "/login"],
};
