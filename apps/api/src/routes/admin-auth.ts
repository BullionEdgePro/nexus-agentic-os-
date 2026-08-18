import { Hono } from "hono";
import { findAdminByEmail, recordAdminLogin, hasWorkingAdminAccount } from "@nexus/db";
import { verifySecret } from "@nexus/employees";
import { logger } from "../lib/logger.js";
import { clientKey, loginBlocked, recordLoginFailure, clearLoginFailures } from "../lib/login-throttle.js";

/**
 * Admin sign-in.
 *
 * Mounted alongside /auth/employee and OUTSIDE /api/*, because `requireAuth`
 * guards everything under there and a sign-in route that needs a session cannot
 * issue one. Like its sibling it returns who signed in and nothing else —
 * apps/web turns that into the session cookie, so there is one signing
 * implementation for both kinds of account.
 *
 * The separation from the employee route is not cosmetic. An admin sees every
 * tenant's customer conversations; an employee sees one business. Two different
 * credential types, two different scopes, two different entrances — and a bug
 * in one cannot widen the other.
 */
export const adminAuthRoute = new Hono();

/**
 * Is the shared operator password still allowed?
 *
 * The shared password is a BOOTSTRAP credential — the way in before any named
 * admin account exists. The login route has said since admin accounts landed
 * that it "should be removed once a real admin account has been created and
 * used", and nothing enforced that, so `demo1234` plus any email has been a
 * full cross-tenant login this whole time.
 *
 * This endpoint is the enforcement. Once a named admin has actually signed in,
 * the bootstrap door closes on its own.
 *
 * UNAUTHENTICATED, DELIBERATELY. The sign-in page has to ask this before anyone
 * has a session — that is the entire situation it describes. What it discloses
 * is one boolean about how this deployment is configured, which is worth far
 * less than the hole it closes, and nothing about who the admins are or how
 * many there are.
 *
 * FAILS CLOSED. If the database cannot be reached, the answer is "retired" and
 * the shared password is refused. A lookup that failed is not evidence that the
 * bootstrap window is open, and treating it as such would mean any database
 * blip re-enables a known password.
 */
adminAuthRoute.get("/admin/bootstrap", async (c) => {
  try {
    const retired = await hasWorkingAdminAccount();
    return c.json({ sharedPasswordRetired: retired });
  } catch (err) {
    logger.error({ err }, "Could not determine bootstrap state — refusing the shared password");
    return c.json({ sharedPasswordRetired: true });
  }
});

adminAuthRoute.post("/admin", async (c) => {
  // Throttled before the credential is even looked up, so a refused source
  // costs one Redis read rather than an scrypt verification. See login-throttle:
  // this counts per SOURCE and never per account, because locking an identifier
  // would let anybody lock the owner out by mistyping their email ten times.
  const source = clientKey(c.req.raw.headers);
  if (await loginBlocked(source)) {
    return c.json(
      { error: "Too many sign-in attempts. Wait a few minutes and try again." },
      429
    );
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return c.json({ error: "Enter your email and password." }, 400);
  }

  const admin = await findAdminByEmail(email);

  // One message whether the account is unknown, deactivated, or the password is
  // wrong. Distinguishing them tells an attacker which admin addresses exist,
  // which is exactly the half of the credential they do not have.
  const denied = { error: "That email and password don't match." } as const;

  if (!admin) {
    logger.warn({ email }, "Admin sign-in failed — no active account");
    await recordLoginFailure(source, email);
    return c.json(denied, 401);
  }

  if (!verifySecret(password, admin.passwordHash)) {
    logger.warn({ adminId: admin.id }, "Admin sign-in failed — password did not verify");
    await recordLoginFailure(source, email);
    return c.json(denied, 401);
  }

  // Cleared on success, so somebody who mistypes nine times and then gets it
  // right is not one typo from a lockout for the rest of the window.
  await clearLoginFailures(source);

  // Best-effort: a failed bookkeeping write must not deny a valid sign-in.
  try {
    await recordAdminLogin(admin.id);
  } catch (err) {
    logger.error({ adminId: admin.id, err }, "Failed to record admin login");
  }

  logger.info({ adminId: admin.id, email: admin.email }, "Admin signed in");

  return c.json({ adminId: admin.id, email: admin.email, fullName: admin.fullName });
});
