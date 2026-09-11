import { Hono } from "hono";
import {
  findOrganizationBySlug,
  listQuickReplies,
  createQuickReply,
  deleteQuickReply,
} from "@nexus/db";

/**
 * A business's quick replies — the composer's canned-response library.
 *
 * Mounted under /api/organizations, so every route here is behind requireAuth,
 * requireTenantScope (who may reach this business) and the tenant middleware
 * (which wraps the request in withTenant(org.id) from the slug). The handlers
 * therefore resolve the org for its id and let RLS do the scoping, exactly as
 * the knowledge route does — a quick reply is the same kind of per-business
 * material, just shorter.
 */
export const quickRepliesRoute = new Hono();

quickRepliesRoute.get("/:slug/quick-replies", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const quickReplies = await listQuickReplies(organization.id);
  return c.json({ quickReplies });
});

quickRepliesRoute.post("/:slug/quick-replies", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req.json<{ title?: unknown; body?: unknown }>().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 80) : "";
  const text = typeof body?.body === "string" ? body.body.trim().slice(0, 4000) : "";
  if (!title) return c.json({ error: "Give the reply a short name." }, 400);
  if (!text) return c.json({ error: "Write the reply itself." }, 400);

  // The session subject, so the list can show who added a reply. Null when there
  // is none — the column allows it, and an unattributed reply is still useful.
  const createdBy = (c.get("scope") as { sub?: string } | undefined)?.sub ?? null;
  const quickReply = await createQuickReply({ organizationId: organization.id, title, body: text, createdBy });
  return c.json({ quickReply }, 201);
});

quickRepliesRoute.delete("/:slug/quick-replies/:id", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const removed = await deleteQuickReply(organization.id, c.req.param("id"));
  if (!removed) return c.json({ error: "Quick reply not found" }, 404);
  return c.json({ ok: true });
});
