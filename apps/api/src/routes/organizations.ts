import { Hono } from "hono";
import {
  listOrganizations,
  findOrganizationBySlug,
  getConversationsForOrganization,
  getOrganizationSocialAccounts,
  updateOrganizationSocialAccounts,
} from "@nexus/db";
import { parseSocialAccounts } from "@nexus/employees";

export const organizationsRoute = new Hono();

/**
 * A business's own social accounts — the company pages, recorded by the owner.
 *
 * Org-scoped and already behind `requireTenantScope` (mounted under
 * /api/organizations/:slug/*), so the slug is pinned to the caller's access.
 * The WRITE is operator-only: a business's public pages are the owner's to set,
 * not a staff member's — staff record their OWN on /api/my/social-accounts.
 * Reads are allowed to anyone scoped to the business, so a staff member can see
 * where the company is online too.
 */
organizationsRoute.get("/:slug/social-accounts", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  return c.json({ accounts: await getOrganizationSocialAccounts(organization.id) });
});

organizationsRoute.patch("/:slug/social-accounts", async (c) => {
  const scope = c.get("scope") as { role?: string } | undefined;
  if (scope?.role !== "operator") {
    return c.json({ error: "Only the owner can set the business's social accounts." }, 403);
  }

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body || !("accounts" in body)) return c.json({ error: "Nothing to change." }, 400);

  // Same validator as the staff directory — jsonb takes any shape, so a mistyped
  // row would store and read back as nonsense.
  const parsed = parseSocialAccounts(body.accounts);
  if (!parsed.ok) return c.json({ error: parsed.errors.join(" "), errors: parsed.errors }, 400);

  const accounts = await updateOrganizationSocialAccounts(organization.id, parsed.accounts ?? []);
  return c.json({ accounts });
});

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
