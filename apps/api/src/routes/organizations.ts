import { Hono } from "hono";
import { listOrganizations, findOrganizationBySlug, getConversationsForOrganization } from "@nexus/db";

export const organizationsRoute = new Hono();

/**
 * The businesses this caller may work in.
 *
 * Filtered rather than refused: the deck needs this list to render its
 * switcher, and an employee returning an empty array would leave them staring
 * at a console with no business selected. The filter is the security boundary's
 * politeness layer only — `requireTenantScope` is what actually stops them
 * reading another tenant, so a bug here degrades the menu, not the data.
 */
organizationsRoute.get("/", async (c) => {
  const scope = c.get("scope");
  const organizations = await listOrganizations();

  if (scope?.role === "employee") {
    return c.json({
      organizations: organizations.filter((organization) => organization.id === scope.organizationId),
    });
  }

  return c.json({ organizations });
});

organizationsRoute.get("/:slug/conversations", async (c) => {
  const slug = c.req.param("slug");
  const organization = await findOrganizationBySlug(slug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const conversations = await getConversationsForOrganization(organization.id);
  return c.json({ conversations });
});
