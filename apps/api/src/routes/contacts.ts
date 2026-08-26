import { Hono } from "hono";
import type { Context } from "hono";
import { toCsv, csvFilename } from "@nexus/shared";
import {
  contactBelongsToBusiness,
  ensureContactForServingBusiness,
  exportContacts,
  exportContactRecord,
  exportMessages,
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

/**
 * A CSV the browser saves rather than renders.
 *
 * text/csv with an explicit charset, because the file carries a UTF-8 BOM
 * and Arabic names, and a browser that guesses the encoding gets both wrong.
 */
function csvResponse(c: Context, csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // An export is a snapshot of a moving record. Cached, it is a snapshot
      // of an older one wearing today's filename.
      "cache-control": "no-store",
    },
  });
}

contactsRoute.get("/:slug/contacts", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const search = c.req.query("q") ?? "";
  return c.json({
    contacts: await listContacts(organization.id, { search }),
  });
});

/**
 * Adding a customer nobody has messaged yet.
 *
 * Built for the diary: an appointment needs somebody to meet, and a person who
 * phoned or walked in has no WhatsApp conversation to be found from. Before
 * this the console could read customers and never create one, so the booking
 * form could only serve people who had already sent a message.
 *
 * The row does NOT land under this business — see `ensureContactForServingBusiness`.
 * It lands under the owner of the shared number, exactly where the webhook
 * would put it, and this business sees them through a routed conversation.
 */
contactsRoute.post("/:slug/contacts", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req.json<{ waId?: string; displayName?: string }>().catch(() => null);
  if (!body?.waId) {
    return c.json({ error: "A WhatsApp number is required." }, 400);
  }

  try {
    const result = await ensureContactForServingBusiness({
      servingOrganizationId: organization.id,
      waId: body.waId,
      displayName: body.displayName ?? null,
    });
    // 200 rather than 201 when they were already known, and `created` says
    // which. Somebody typing in a customer who turns out to be on file already
    // has not made a mistake, and should not be told they have -- but the
    // screen still needs to be able to say "this person was already here".
    return c.json(result, result.created ? 201 : 200);
  } catch (err) {
    // The sentences thrown from there are written for a form.
    const message = err instanceof Error ? err.message : "Could not add that customer.";
    logger.warn({ slug: organization.slug, err }, "Manual contact creation refused");
    return c.json({ error: message }, 400);
  }
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

/**
 * Getting the business's own data out.
 *
 * ============================================================
 * WHY THIS EXISTS AT ALL
 * ============================================================
 *
 * There was no export anywhere in this product. The only download it offered
 * was a QR code. A business could ask this platform to FORGET a customer --
 * as of today -- and could not obtain a single row of its own records.
 *
 * That is table stakes for a CRM, and it is also the sibling of the erase
 * button: "delete what you hold about me" and "give me what you hold about
 * me" are one request asked two ways, and this platform could answer the
 * first from a screen and the second not at all.
 *
 * ============================================================
 * WHAT AN EXPORT MUST NOT CONTAIN
 * ============================================================
 *
 * Another firm's customers. Two competing law firms answer on this number, so
 * every query here is scoped through the same predicate the screens use --
 * the egress policy is the architecture, not a setting.
 */
contactsRoute.get("/:slug/export/customers.csv", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const rows = await exportContacts(organization.id);
  const headers = rows[0] ? Object.keys(rows[0]) : ["phone", "name"];
  const csv = toCsv(headers, rows.map((row) => headers.map((h) => row[h])));

  logger.info(
    { organizationId: organization.id, rows: rows.length },
    "A business exported its customer list"
  );
  return csvResponse(c, csv, csvFilename(organization.slug, "customers", new Date()));
});

contactsRoute.get("/:slug/export/messages.csv", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const { rows, truncated } = await exportMessages(organization.id);
  const headers = ["conversation_id", "phone", "name", "sent_at", "direction", "sender_type", "body"];
  const csv = toCsv(headers, rows.map((row) => headers.map((h) => row[h])));

  // SAID IN A HEADER, not swallowed. A truncated record that looks complete
  // is worse than no record: somebody would reconcile against it and find a
  // gap they could not explain.
  const response = csvResponse(c, csv, csvFilename(organization.slug, "messages", new Date()));
  if (truncated) response.headers.set("x-export-truncated", "true");
  return response;
});

/**
 * Everything held about ONE person, as JSON.
 *
 * The answer to a subject access request, and the reason it is JSON rather
 * than CSV: it is a nested record -- a person, their assessments, their
 * conversations and every message in them -- and flattening that into a grid
 * would lose the shape somebody asked to see.
 *
 * Unlike the bulk export this DOES carry the remembered summary, because the
 * subject of that summary is the one person entitled to read it.
 */
contactsRoute.get("/:slug/contacts/:contactId/export.json", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const contactId = c.req.param("contactId");
  const record = await exportContactRecord(organization.id, contactId);
  if (!record) return c.json({ error: "Customer not found" }, 404);

  const memory = await getContactMemory(organization.id, contactId);
  const body = {
    ...record,
    remembered: memory ? { summary: memory.summary, updatedAt: memory.updatedAt } : null,
    exportedAt: new Date().toISOString(),
    exportedBy: organization.slug,
  };

  logger.info(
    { organizationId: organization.id, contactId },
    "A customer's full record was exported"
  );

  c.header("content-type", "application/json; charset=utf-8");
  c.header(
    "content-disposition",
    `attachment; filename="${organization.slug}-customer-${contactId.slice(0, 8)}.json"`
  );
  return c.body(JSON.stringify(body, null, 2));
});
