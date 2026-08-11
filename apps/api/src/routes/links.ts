import { Hono } from "hono";
import { listOrganizations } from "@nexus/db";
import { buildDeepLink } from "@nexus/agents";

/**
 * The link each business publishes so its customers skip triage.
 *
 * Cross-tenant by nature — the point is to hand the operator every business's
 * link at once — so it is mounted operator-only alongside the other
 * platform-wide reads.
 */
export const linksRoute = new Hono();

linksRoute.get("/", async (c) => {
  const organizations = await listOrganizations();

  const links = organizations.map((organization) => ({
    slug: organization.slug,
    name: organization.name,
    number: organization.whatsappDisplayNumber,
    // Built from the DIALABLE number, never from whatsapp_phone_number_id —
    // that is Meta's internal id (1283383404852750) and a wa.me link made from
    // it looks correct, gets published on a website, and fails for every
    // customer who taps it. A business with no number gets null rather than a
    // link that cannot work.
    url: organization.whatsappDisplayNumber
      ? buildDeepLink(
          { id: organization.id, slug: organization.slug, name: organization.name, routingKeywords: [] },
          organization.whatsappDisplayNumber
        )
      : null,
    unavailableReason: organization.whatsappDisplayNumber
      ? null
      : "This business has no WhatsApp number a customer could message yet.",
  }));

  return c.json({ links });
});
