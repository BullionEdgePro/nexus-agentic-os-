import { Hono } from "hono";
import { getEmployeeActivity, getRecentActivity, findOrganizationBySlug } from "@nexus/db";

/**
 * Employee activity, for the people who run the platform.
 *
 * Mounted under /api/* so `requireAuth` covers it, and additionally gated
 * operator-only at the mount — an employee must not be able to read their
 * colleagues' numbers, and on a shared platform "colleagues" would mean every
 * other business's staff too.
 *
 * An admin sees everyone by default, or one business with ?business=<slug>.
 */
export const activityRoute = new Hono();

activityRoute.get("/", async (c) => {
  const slug = c.req.query("business");

  let organizationId: string | null = null;
  if (slug) {
    const organization = await findOrganizationBySlug(slug);
    if (!organization) return c.json({ error: "Organization not found" }, 404);
    organizationId = organization.id;
  }

  const [employees, events] = await Promise.all([
    getEmployeeActivity(organizationId),
    getRecentActivity(40),
  ]);

  return c.json({
    employees,
    events: slug ? events.filter((event) => event.organizationSlug === slug) : events,
  });
});
