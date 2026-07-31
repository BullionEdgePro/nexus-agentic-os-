import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  const { pathname } = req.nextUrl;

  // Guard the command deck: no valid session → send to login.
  if (pathname.startsWith("/deck") && !session) {
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
  matcher: ["/deck/:path*", "/login"],
};
