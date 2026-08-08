import { Hono } from "hono";
import { findEmployeeForLogin, recordEmployeeLogin } from "@nexus/db";
import { verifyAccessCode } from "@nexus/employees";
import { logger } from "../lib/logger.js";

/**
 * Employee sign-in.
 *
 * Mounted OUTSIDE /api/*, because `requireAuth` guards everything under there
 * and a login endpoint that requires a session cannot issue one. That makes
 * this one of only three unauthenticated surfaces on the service — alongside
 * /health and the HMAC-verified Meta webhook — so it is deliberately narrow: it
 * returns who signed in and nothing else, and apps/web turns that into the
 * session cookie.
 *
 * It does not issue the cookie itself because signing lives in apps/web, and
 * one signing implementation is the reason a single login works for both the
 * UI and the API.
 */
export const employeeAuthRoute = new Hono();

employeeAuthRoute.post("/employee", async (c) => {
  let body: { identifier?: unknown; accessCode?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const identifier = typeof body.identifier === "string" ? body.identifier : "";
  const accessCode = typeof body.accessCode === "string" ? body.accessCode : "";
  if (!identifier || !accessCode) {
    return c.json({ error: "Sign-in needs your email or staff code, and your access code." }, 400);
  }

  const candidate = await findEmployeeForLogin(identifier);

  // One message for "no such employee", "no code issued" and "wrong code".
  // Distinguishing them would let anyone with the form enumerate who works at
  // which business, which is exactly the information a targeted attempt needs.
  const denied = { error: "That access code doesn't match." } as const;

  if (!candidate) {
    logger.warn({ identifier }, "Employee sign-in failed — no unique active match");
    return c.json(denied, 401);
  }

  if (!verifyAccessCode(accessCode, candidate.accessCodeHash)) {
    logger.warn(
      { employeeId: candidate.id, organizationSlug: candidate.organizationSlug },
      "Employee sign-in failed — access code did not verify"
    );
    return c.json(denied, 401);
  }

  // Best-effort: a failed bookkeeping write must not deny a valid sign-in.
  try {
    await recordEmployeeLogin(candidate.id);
  } catch (err) {
    logger.error({ employeeId: candidate.id, err }, "Failed to record employee login");
  }

  logger.info(
    { employeeId: candidate.id, organizationSlug: candidate.organizationSlug },
    "Employee signed in"
  );

  return c.json({
    employeeId: candidate.id,
    fullName: candidate.fullName,
    organizationId: candidate.organizationId,
    organizationSlug: candidate.organizationSlug,
    organizationName: candidate.organizationName,
  });
});
