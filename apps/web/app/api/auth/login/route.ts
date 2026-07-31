import { NextResponse } from "next/server";
import { signSession, operatorPassword, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const email = (body.email ?? "").trim();
  const password = (body.password ?? "").trim();

  if (!email || !/.+@.+\..+/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email to continue." }, { status: 400 });
  }
  if (password !== operatorPassword()) {
    return NextResponse.json({ error: "That password doesn't match this operator account." }, { status: 401 });
  }

  const token = await signSession(email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
