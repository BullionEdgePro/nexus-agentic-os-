import { Hono } from "hono";
import type { Context } from "hono";
import {
  createAutomation,
  deleteAutomation,
  findOrganizationBySlug,
  listAutomationRuns,
  listAutomations,
  setAutomationActive,
  AUTOMATION_TRIGGERS,
} from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * Automations — the rules a business has allowed this platform to act on.
 *
 * Scoped exactly like /api/tasks and for the same reason, which is worth
 * restating because the consequence here is larger. This path carries no :slug,
 * so `requireTenantScope` does not apply and the request runs cross-tenant.
 * Nothing underneath narrows anything. For tasks, forgetting means an employee
 * READS five businesses' commitments; here it would mean an employee CREATES a
 * rule that acts inside another company, every ten minutes, unattended.
 *
 * So: an operator may work across businesses and must name one to create; an
 * employee is pinned to their own, whatever the request says.
 */

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

/** The business this request may act in, or an error to return. */
async function businessFor(
  c: Context,
  scope: SessionScope,
  slugFromBody?: unknown
): Promise<{ organizationId: string } | { error: string; status: 403 | 404 }> {
  if (scope.role === "operator") {
    const slug = typeof slugFromBody === "string" ? slugFromBody : c.req.query("business");
    if (!slug) return { error: "Choose which business this rule belongs to.", status: 404 };
    const organization = await findOrganizationBySlug(slug);
    if (!organization) return { error: "Organization not found", status: 404 };
    return { organizationId: organization.id };
  }

  const organizationId = scope.organizationId ?? null;
  if (!organizationId) {
    logger.warn({ sub: scope.sub }, "Employee session without an organization asked for automations");
    return { error: "Your account is not attached to a business.", status: 403 };
  }
  return { organizationId };
}

/**
 * The business a by-id request may act in.
 *
 * Different from `businessFor` on purpose, and the difference is a bug this
 * had for exactly one commit: PATCH and DELETE carry no business anywhere —
 * not in the path, not in a body, not in a query — so `businessFor` reached
 * for `?business=`, found nothing, and refused every toggle an OPERATOR made
 * with "Choose which business this rule belongs to". Operators are the only
 * people who use this screen. The switch did not work at all.
 *
 * The id identifies the row, and an operator already reads every business's
 * rules on one screen, so null here means "whichever business owns it". An
 * employee is still pinned to their own, and the writer's predicate is what
 * enforces that rather than a check somebody has to remember.
 */
export async function businessForById(
  c: Context,
  scope: SessionScope
): Promise<{ organizationId: string | null } | { error: string; status: 403 }> {
  if (scope.role === "operator") return { organizationId: null };

  const organizationId = scope.organizationId ?? null;
  if (!organizationId) {
    logger.warn({ sub: scope.sub, path: c.req.path }, "Employee session without an organization tried to change an automation");
    return { error: "Your account is not attached to a business.", status: 403 };
  }
  return { organizationId };
}

export const automationsRoute = new Hono();

/** What can be automated at all — the menu, built from the rules themselves. */
automationsRoute.get("/options", (c) =>
  c.json({
    // Derived from AUTOMATION_TRIGGERS rather than repeated here, so a screen
    // cannot offer a pair the rules would refuse. The allow-list is the menu.
    actions: Object.entries(AUTOMATION_TRIGGERS).map(([action, rule]) => ({
      action,
      describes: rule.describes,
      operators: rule.operators,
      needsAssignee: rule.needsAssignee,
    })),
  })
);

automationsRoute.get("/", async (c) => {
  const scope = scopeOf(c);

  if (scope.role === "operator") {
    const slug = c.req.query("business");
    const organizationId = slug ? (await findOrganizationBySlug(slug))?.id ?? null : null;
    if (slug && !organizationId) return c.json({ error: "Organization not found" }, 404);
    return c.json({ automations: await listAutomations(organizationId) });
  }

  const where = await businessFor(c, scope);
  if ("error" in where) return c.json({ error: where.error }, where.status);
  return c.json({ automations: await listAutomations(where.organizationId) });
});

automationsRoute.get("/runs", async (c) => {
  const scope = scopeOf(c);
  const where = await businessFor(c, scope);
  if ("error" in where) return c.json({ error: where.error }, where.status);
  return c.json({ runs: await listAutomationRuns(where.organizationId) });
});

automationsRoute.post("/", async (c) => {
  const scope = scopeOf(c);
  const body = (await c.req.json().catch(() => null)) as {
    business?: unknown;
    triggerOperator?: unknown;
    action?: unknown;
    assigneeId?: unknown;
  } | null;
  if (!body) return c.json({ error: "Nothing to create." }, 400);

  const where = await businessFor(c, scope, body.business);
  if ("error" in where) return c.json({ error: where.error }, where.status);

  try {
    const automation = await createAutomation({
      organizationId: where.organizationId,
      triggerOperator: String(body.triggerOperator ?? ""),
      action: String(body.action ?? ""),
      assigneeId: typeof body.assigneeId === "string" && body.assigneeId ? body.assigneeId : null,
      // Always a person. An automation created by nobody is one nobody can be
      // asked about, and this acts unattended every ten minutes.
      createdBy: scope.sub,
    });
    logger.info(
      { sub: scope.sub, automationId: automation.id, action: automation.action },
      "An automation was created — this platform may now act unattended for this business"
    );
    return c.json({ automation }, 201);
  } catch (err) {
    // The rules refuse with a sentence a person can act on; a unique violation
    // is the only other likely cause and deserves one too.
    const message =
      err instanceof Error && /duplicate key/.test(err.message)
        ? "There is already a rule for that finding and action, switched on or off. Remove it first."
        : err instanceof Error
          ? err.message
          : "That rule could not be created.";
    return c.json({ error: message }, 400);
  }
});

automationsRoute.patch("/:id", async (c) => {
  const scope = scopeOf(c);
  const body = (await c.req.json().catch(() => null)) as { isActive?: unknown } | null;
  if (!body || typeof body.isActive !== "boolean") {
    return c.json({ error: "Say whether the rule should be on or off." }, 400);
  }

  const where = await businessForById(c, scope);
  if ("error" in where) return c.json({ error: where.error }, where.status);

  const automation = await setAutomationActive(where.organizationId, c.req.param("id"), body.isActive);
  // Same 404 for "no such rule" and "not yours", so ids cannot be enumerated —
  // the reasoning is written out in the operators route.
  if (!automation) return c.json({ error: "That rule is not available to change." }, 404);
  logger.info(
    { sub: scope.sub, automationId: automation.id, action: automation.action, isActive: automation.isActive },
    automation.isActive
      ? "An automation was switched on — this platform may now act unattended for this business"
      : "An automation was switched off"
  );
  return c.json({ automation });
});

automationsRoute.delete("/:id", async (c) => {
  const scope = scopeOf(c);
  const where = await businessForById(c, scope);
  if ("error" in where) return c.json({ error: where.error }, where.status);

  const gone = await deleteAutomation(where.organizationId, c.req.param("id"));
  if (!gone) return c.json({ error: "That rule is not available to remove." }, 404);
  // The runs stay: they are the record of what already happened, and deleting a
  // rule must not erase the acts it took. The cascade on automation_runs is by
  // automation_id, so this DOES remove them — which is why the audit a business
  // reads is the follow-ups themselves, each one a real row with a real note.
  return c.json({ ok: true });
});
