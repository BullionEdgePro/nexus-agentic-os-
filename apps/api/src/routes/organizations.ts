import { Hono } from "hono";
import {
  listOrganizations,
  findOrganizationBySlug,
  getConversationsForOrganization,
  getOrganizationSocialAccounts,
  updateOrganizationSocialAccounts,
  getInboxSettings,
  updateInboxSettings,
} from "@nexus/db";
import { parseSocialAccounts } from "@nexus/employees";
import { readerOf } from "../lib/actor.js";
import type { SessionScope } from "../lib/session.js";

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

  // 200, not 50: the folder and channel counts are computed over this list, and
  // at 50 a busy business's "Awaiting reply (12)" quietly meant "of the latest
  // fifty". The reader decides each row's unread count (migration 090).
  const reader = readerOf(c.get("scope") as SessionScope | undefined);
  const conversations = await getConversationsForOrganization(organization.id, 200, reader);
  return c.json({ conversations });
});

// ============================================================
// Inbox settings — the business's pipeline stages and reply-time target
// ============================================================
//
// Read by everyone who works the inbox (the stage tabs, the "late" folder and
// the in-thread SLA banner all use them); changed only by the owner. Null resets
// a setting to its default.

organizationsRoute.get("/:slug/inbox-settings", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  const settings = await getInboxSettings(organization.id);
  return c.json({ settings });
});

organizationsRoute.patch("/:slug/inbox-settings", async (c) => {
  const scope = c.get("scope") as SessionScope | undefined;
  if (scope?.role !== "operator") {
    return c.json({ error: "Only the owner can change the inbox settings." }, 403);
  }
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req
    .json<{ stages?: unknown; slaMinutes?: unknown; autoAssign?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const patch: { stages?: string[] | null; slaMinutes?: number | null; autoAssign?: boolean } = {};
  if ("autoAssign" in body) {
    if (typeof body.autoAssign !== "boolean") return c.json({ error: "autoAssign must be true or false" }, 400);
    patch.autoAssign = body.autoAssign;
  }
  if ("stages" in body) {
    if (body.stages === null) {
      patch.stages = null;
    } else if (Array.isArray(body.stages)) {
      const seen = new Set<string>();
      const stages: string[] = [];
      for (const raw of body.stages) {
        if (typeof raw !== "string") continue;
        const label = raw.trim().slice(0, 40);
        if (!label || seen.has(label.toLowerCase())) continue;
        seen.add(label.toLowerCase());
        stages.push(label);
        if (stages.length >= 15) break;
      }
      if (stages.length === 0) return c.json({ error: "Keep at least one stage, or reset to the defaults." }, 400);
      patch.stages = stages;
    } else {
      return c.json({ error: "stages must be a list of names" }, 400);
    }
  }
  if ("slaMinutes" in body) {
    if (body.slaMinutes === null) {
      patch.slaMinutes = null;
    } else {
      const n = Number(body.slaMinutes);
      if (!Number.isInteger(n) || n < 5 || n > 10080) {
        return c.json({ error: "The reply-time target must be between 5 minutes and 7 days." }, 400);
      }
      patch.slaMinutes = n;
    }
  }

  const settings = await updateInboxSettings(organization.id, patch);
  return c.json({ settings });
});
