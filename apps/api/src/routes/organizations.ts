import { Hono } from "hono";
import { listOrganizations, findOrganizationBySlug, getConversationsForOrganization } from "@nexus/db";

export const organizationsRoute = new Hono();

organizationsRoute.get("/", async (c) => {
  const organizations = await listOrganizations();
  return c.json({ organizations });
});

organizationsRoute.get("/:slug/conversations", async (c) => {
  const slug = c.req.param("slug");
  const organization = await findOrganizationBySlug(slug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const conversations = await getConversationsForOrganization(organization.id);
  return c.json({ conversations });
});
