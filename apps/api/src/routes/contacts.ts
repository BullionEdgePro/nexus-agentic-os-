import { Hono } from "hono";
import {
  contactBelongsToBusiness,
  findOrganizationBySlug,
  forgetContact,
  getContact,
  getContactMemory,
  listContacts,
  withServingTenant,
} from "@nexus/db";
import { logger } from "../lib/logger.js";

/**
 * Customers.
 *
 * ============================================================
 * WHY THIS IS MOUNTED PER ORGANIZATION
 * ============================================================
 *
 * Every row here is a real person: their name, their phone number, what they
 * asked about, and what this platform has remembered about them. That is the
 * most sensitive read in the product, more so than the inbox, because it
 * assembles into one place what was previously spread across five tables.
 *
 * So it carries a :slug and sits behind `requireTenantScope`, which pins an
 * employee to their own business before anything below runs. The alternative --
 * a bare /api/contacts scoped in the handler, as tasks and automations are --
 * would work, and would put the only thing standing between two law firms
 * sharing a phone number in a check somebody has to remember to write.
 */
export const contactsRoute = new Hono();

contactsRoute.get("/:slug/contacts", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const search = c.req.query("q") ?? "";
  return c.json({
    contacts: await listContacts(organization.id, { search }),
  });
});

contactsRoute.get("/:slug/contacts/:contactId", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const contact = await getContact(organization.id, c.req.param("contactId"));
  // Same 404 for "no such contact" and "not one of yours". Telling one firm
  // that a person exists elsewhere on this number is an answer it has no reason
  // to have -- and on a shared number it is a question two competitors could
  // ask about each other's clients.
  if (!contact) return c.json({ error: "Customer not found" }, 404);

  // `getContactMemory` widens to the serving business itself -- it is one of
  // the reads that learned to, after four of five businesses spent weeks
  // getting empty answers. Called here rather than folded into getContact so
  // that the widening stays where its comment is.
  const memory = await getContactMemory(organization.id, contact.id);

  return c.json({
    contact,
    // What this platform holds about them, in the words it holds it in. Shown
    // rather than summarised: a person asking "what do you know about me"
    // deserves the actual text, and a person deciding whether to erase it
    // cannot decide without reading it.
    memory: memory
      ? {
          summary: memory.summary,
          sourceMessages: memory.sourceMessages,
          lastSeenAt: memory.lastSeenAt,
          updatedAt: memory.updatedAt,
        }
      : null,
  });
});

/**
 * Forget what is held about one customer.
 *
 * `forgetContact` has existed since episodic memory shipped, and its own
 * comment says why: "delete what you hold about me" is a request a customer can
 * make, and an answer of "we would have to write some code" is not one. Until
 * this route existed the only caller was a verification script, so the honest
 * answer was still "we would have to run something".
 *
 * It removes the MEMORY, not the person. The conversations stay, because they
 * are the business's own record of what was said and are not this platform's to
 * erase on one operator's click; the remembered summary is the part this
 * platform inferred and holds on its own account.
 */
contactsRoute.delete("/:slug/contacts/:contactId/memory", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const contactId = c.req.param("contactId");
  const entitled = await contactBelongsToBusiness(organization.id, contactId);
  if (!entitled) return c.json({ error: "Customer not found" }, 404);

  const forgotten = await withServingTenant(organization.id, () =>
    forgetContact(organization.id, contactId)
  );

  // Logged as an act, because it is one and it is irreversible. The contact id
  // only -- the summary being erased is the sensitive part and putting it in a
  // log would defeat the request that prompted this.
  logger.info(
    { organizationId: organization.id, contactId, hadMemory: forgotten },
    "A customer's remembered summary was erased"
  );

  // `false` means there was nothing held, which is not a failure and must not
  // read as one: "we hold nothing about them" is the state the caller asked
  // for, however it was reached.
  return c.json({ ok: true, hadMemory: forgotten });
});
