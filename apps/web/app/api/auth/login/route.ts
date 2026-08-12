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
 * Sign in — as an admin, or as an employee.
 *
 * `mode` decides which credential is accepted, and the two entrances never
 * check each other's:
 *
 *   admin  (/admin)  — a named admin account, or the shared
 *                      NEXUS_OPERATOR_PASSWORD while it still exists.
 *                      Scope: every business.
 *   staff  (/)       — an employee's issued access code.
 *                      Scope: their one business.
 *
 * Keeping them apart matters because the scopes are so different. An admin sees
 * every tenant's customer conversations; an employee sees one. A bug in the
 * staff path cannot hand out an admin session, because the staff path never
 * calls the admin verifier.
 *
 * Both are verified by the API, which owns the database, and the cookie is
 * signed here so there is one signing implementation and one session format.
 */
export async function POST(req: Request) {
  let body: { email?: string; password?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const identifier = (body.email ?? "").trim();
  const secret = (body.password ?? "").trim();
  const mode = body.mode === "admin" ? "admin" : "staff";

  if (!identifier) {
    return NextResponse.json(
      { error: mode === "admin" ? "Enter your email." : "Enter your email or staff code." },
      { status: 400 }
    );
  }
  if (!secret) {
    return NextResponse.json(
      { error: mode === "admin" ? "Enter your password." : "Enter your access code." },
      { status: 400 }
    );
  }

  if (mode === "admin") {
    const admin = await verifyAdmin(identifier, secret);
    if (admin) {
      return issue(admin.email, { role: "operator", adminId: admin.adminId });
    }

    // The shared password is a BOOTSTRAP credential and now behaves like one.
    //
    // It exists so the platform's owner can get in before any named admin
    // account exists. The comment that used to sit here said it "should be
    // removed once a real admin account has been created and used" — a
    // condition stated and never enforced, which meant `demo1234` plus any
    // syntactically valid email was a full cross-tenant login into five
    // businesses' customer conversations for as long as admin accounts existed.
    //
    // Now the condition enforces itself: once a named admin has actually signed
    // in, this door closes. Checked against "has signed in" rather than "exists"
    // on purpose — see hasWorkingAdminAccount. A create script that ran with a
    // password nobody kept would otherwise lock the owner out of their own
    // console, turning a security fix into an outage.
    if (secret === operatorPassword() && /.+@.+\..+/.test(identifier)) {
      if (await sharedPasswordRetired()) {
        console.warn(
          "[auth] Shared operator password refused — a named admin account is in use. Sign in with that account."
        );
        return NextResponse.json(
          {
            error:
              "The shared password has been retired. Sign in with your admin account.",
          },
          { status: 401 }
        );
      }
      // Loud, every single time, for as long as this window is open. A warning
      // that only fires once is invisible in a log nobody tails.
      console.warn(
        `[auth] SHARED OPERATOR PASSWORD USED by "${identifier}". This grants access to every business. ` +
          "Create an admin account and sign in with it — that retires this password automatically."
      );
      return issue(identifier, { role: "operator" });
    }

    return NextResponse.json({ error: "That email and password don't match." }, { status: 401 });
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

  // One message for every staff failure. Telling someone their email was
  // recognised but the code was wrong confirms who works here, which is exactly
  // what a targeted attempt is missing.
  return NextResponse.json({ error: "That sign-in doesn't match." }, { status: 401 });
}

/**
 * Whether the bootstrap window has closed.
 *
 * Fails CLOSED — an unreachable API means the shared password is refused. The
 * opposite reading is the dangerous one: a failed lookup is not evidence that
 * no admin account exists, and treating it as such would let any transient
 * outage re-enable a known password. Being unable to sign in for a minute is
 * recoverable; the alternative is not.
 */
async function sharedPasswordRetired(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/auth/admin/bootstrap`, { cache: "no-store" });
    if (!response.ok) return true;
    const data = (await response.json()) as { sharedPasswordRetired?: boolean };
    return data.sharedPasswordRetired !== false;
  } catch {
    return true;
  }
}

async function verifyAdmin(
  email: string,
  password: string
): Promise<{ adminId: string; email: string } | null> {
  try {
    const response = await fetch(`${API_URL}/auth/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { adminId?: string; email?: string };
    if (!data.adminId || !data.email) return null;
    return { adminId: data.adminId, email: data.email };
  } catch {
    // The API being unreachable is not a failed credential, but it is not a
    // successful one either. Denying is the only safe reading.
    return null;
  }
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
