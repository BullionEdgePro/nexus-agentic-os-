import { Hono } from "hono";
import { findOrganizationBySlug, getWorkflowAudit } from "@nexus/db";
import type { AuditDays } from "@nexus/shared";

/**
 * The workflow audit (2 Nov 2026): what a business's own data shows of the
 * workflow its owner drew, for the last 7, 30 or 90 of its days.
 *
 * MOUNTED UNDER /api/organizations/:slug, like the forecast, for the same two
 * reasons: `requireTenantScope` lets an admin into any business and staff only
 * into their own, and the read runs inside `withTenant`, so the database's
 * row-level security does real work. It is the business's own operational
 * picture — every SFS staff member sees the whole team's figures — and never
 * lists a colleague's numbers by name.
 *
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §2, §7
 */
export const workflowAuditRoute = new Hono();

/** 7, 30 or 90 — the only periods there are; nothing given means 30. */
export function parseAuditDays(raw: string | undefined): AuditDays | null {
  if (raw === undefined) return 30;
  return raw === "7" ? 7 : raw === "30" ? 30 : raw === "90" ? 90 : null;
}

workflowAuditRoute.get("/:slug/workflow-audit", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const days = parseAuditDays(c.req.query("days"));
  if (days === null) return c.json({ error: "days must be 7, 30 or 90" }, 400);

  const audit = await getWorkflowAudit({
    organizationId: organization.id,
    slug: organization.slug,
    name: organization.name,
    timezone: organization.timezone,
    days,
  });
  return c.json(audit);
});
