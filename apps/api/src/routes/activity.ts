import { Hono } from "hono";
import {
  getEmployeeActivity,
  getRecentActivity,
  findOrganizationBySlug,
  getStaffResponseTimes,
  getInboxSettings,
} from "@nexus/db";

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

/**
 * How fast each person answers a waiting customer — per business or across all,
 * over the last 7, 30 or 90 days. Operator-only by the same mount as the rest
 * of /api/activity (index.ts), for the same reason: it is a colleague's numbers.
 *
 * The target is the business's own reply-time target (inbox settings, migration
 * 090) when one business is chosen, and the default when looking across all.
 */
const PERIODS = new Set([7, 30, 90]);

activityRoute.get("/response-times", async (c) => {
  const slug = c.req.query("business");
  const days = Number(c.req.query("days") ?? 30);
  if (!PERIODS.has(days)) return c.json({ error: "Choose 7, 30 or 90 days." }, 400);

  let organizationId: string | null = null;
  let targetMinutes = 180;
  if (slug) {
    const organization = await findOrganizationBySlug(slug);
    if (!organization) return c.json({ error: "Organization not found" }, 404);
    organizationId = organization.id;
    targetMinutes = (await getInboxSettings(organization.id)).slaMinutes;
  }

  const staff = await getStaffResponseTimes(organizationId, days, targetMinutes);
  return c.json({ staff, days, targetMinutes });
});
