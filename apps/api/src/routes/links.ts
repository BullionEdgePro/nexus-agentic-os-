import { Hono } from "hono";
import { listOrganizations, getDisplayNumbers } from "@nexus/db";
import { buildDeepLink } from "@nexus/agents";

/**
 * The link each business publishes so its customers skip triage.
 *
 * Cross-tenant by nature — the point is to hand the operator every business's
 * link at once — so it is mounted operator-only alongside the other
 * platform-wide reads.
 */
export const linksRoute = new Hono();

/**
 * The same links, unauthenticated.
 *
 * WHY A PUBLIC ENDPOINT IS THE RIGHT CALL HERE, stated because "public" and
 * "customer data" in one sentence deserves an argument rather than a shrug.
 *
 * These links exist to be published. Their whole purpose is to end up on
 * websites, in Instagram bios and on QR codes taped to shop windows. There is
 * nothing here a customer would not see the moment one is published: five
 * business names that are already on the landing page, and one WhatsApp number
 * that is printed for people to message. Gating them behind a login meant the
 * person who actually manages a business's website needed an operator account
 * to get the link they were being asked to paste — so the links reached nobody.
 *
 * What this deliberately does NOT expose: anything about conversations,
 * contacts, employees or performance. It is the same shape the deck sees, and
 * that shape was already only ever public-facing material.
 *
 * Mounted OUTSIDE /api/*, which is where `requireAuth` lives — the same reason
 * the sign-in routes are.
 */
export const publicLinksRoute = new Hono();

async function buildLinks() {
  const [organizations, numbers] = await Promise.all([listOrganizations(), getDisplayNumbers()]);

  return organizations.map((organization) => {
    // Resolved once. Calling numbers.get() three times invites the version
    // where two of them agree and the third does not.
    const number = numbers.get(organization.id);

    return {
      slug: organization.slug,
      name: organization.name,
      number: number ?? null,
      // Built from the DIALABLE number, never from whatsapp_phone_number_id —
      // that is Meta's internal id (1283383404852750), and a wa.me link made
      // from it looks correct, gets published on a website, and fails for every
      // customer who taps it. A business without a number gets null rather than
      // a link that cannot work.
      url: number
        ? buildDeepLink(
            {
              id: organization.id,
              slug: organization.slug,
              name: organization.name,
              routingKeywords: [],
            },
            number
          )
        : null,
      unavailableReason: number
        ? null
        : "This business has no WhatsApp number a customer could message yet.",
    };
  });
}

// Both doors read the same builder, so the page an operator sees and the page
// they hand to a web designer cannot describe different links.
linksRoute.get("/", async (c) => c.json({ links: await buildLinks() }));

publicLinksRoute.get("/", async (c) => {
  // Cached at the edge for five minutes. This is the one page on the platform
  // that may be opened by people who are not staff — a designer, a printer, a
  // shop assistant — and it changes only when a business's number does.
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ links: await buildLinks() });
});
