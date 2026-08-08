import { NextResponse } from "next/server";
import {
  signSession,
  operatorPassword,
  sessionCookieDomain,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  type SessionClaims,
} from "@/lib/auth";

export const runtime = "nodejs";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

/**
 * Sign in, as either the operator or an employee.
 *
 * Two credentials reach the same cookie:
 *  - the operator password, which sees all five businesses, and
 *  - an employee access code, which sees exactly one.
 *
 * The operator check runs first and locally. The employee check has to reach
 * the API because that is where the database is — apps/web has no connection of
 * its own — but the cookie is still signed here, so there is one signing
 * implementation and one session format for the UI and the API both.
 */
export async function POST(req: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const identifier = (body.email ?? "").trim();
  const secret = (body.password ?? "").trim();

  if (!identifier) {
    return NextResponse.json({ error: "Enter your email or staff code." }, { status: 400 });
  }
  if (!secret) {
    return NextResponse.json({ error: "Enter your password or access code." }, { status: 400 });
  }

  // The operator signs in with an email; an employee may use a staff code, so
  // the email format is no longer required of everyone. It is still required of
  // the operator, whose credential is the one worth guarding against a typo
  // that would otherwise fall through to the employee lookup.
  if (secret === operatorPassword() && /.+@.+\..+/.test(identifier)) {
    return issue(identifier, { role: "operator" });
  }

  const employee = await verifyEmployee(identifier, secret);
  if (employee) {
    return issue(employee.signInAs, {
      role: "employee",
      employeeId: employee.employeeId,
      organizationId: employee.organizationId,
      organizationSlug: employee.organizationSlug,
    });
  }

  // One message for both paths. Telling someone their email was recognised but
  // the code was wrong confirms who works here, which is exactly what a
  // targeted attempt is missing.
  return NextResponse.json({ error: "That sign-in doesn't match." }, { status: 401 });
}

async function verifyEmployee(
  identifier: string,
  accessCode: string
): Promise<{
  signInAs: string;
  employeeId: string;
  organizationId: string;
  organizationSlug: string;
} | null> {
  try {
    const response = await fetch(`${API_URL}/auth/employee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, accessCode }),
      // The credential is in the body; a stale cookie must not influence this.
      cache: "no-store",
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      employeeId?: string;
      organizationId?: string;
      organizationSlug?: string;
    };
    if (!data.employeeId || !data.organizationId || !data.organizationSlug) return null;

    return {
      signInAs: identifier,
      employeeId: data.employeeId,
      organizationId: data.organizationId,
      organizationSlug: data.organizationSlug,
    };
  } catch {
    // The API being unreachable is not a failed credential, but it is not a
    // successful one either. Denying is the only safe reading.
    return null;
  }
}

async function issue(subject: string, claims: SessionClaims) {
  const token = await signSession(subject, claims);
  const res = NextResponse.json({ ok: true, role: claims.role });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    domain: sessionCookieDomain(),
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
