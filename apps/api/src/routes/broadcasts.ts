import { Hono } from "hono";
import {
  createBroadcast,
  getBroadcastTemplate,
  getContactsForAudience,
  createBroadcastRecipients,
  updateBroadcastStatus,
  findOrganizationBySlug,
  findOrganizationById,
  listBroadcastTemplates,
  listBroadcasts,
  countReachableContacts,
  getBroadcast,
} from "@nexus/db";
import type { AudienceFilter } from "@nexus/shared";
import { attributeTemplate, describeWrongTemplate, isHiddenTemplate } from "@nexus/shared";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { syncTemplatesForOrganization } from "../services/template-sync.js";
import { logger } from "../lib/logger.js";

export const broadcastsRoute = new Hono();

// Everything a bulk send needs before one can be composed: the templates
// registered for this business, past sends, and how many contacts are actually
// reachable. Returned together because the page is useless without all three —
// a compose form with no template list and no audience count is a form that
// can only fail.
broadcastsRoute.get("/:slug", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const [templates, broadcasts, reachable] = await Promise.all([
    listBroadcastTemplates(organization.id),
    listBroadcasts(organization.id),
    countReachableContacts(organization.id),
  ]);

  // Every template on the shared WhatsApp account arrives under every business,
  // so the list is annotated rather than trusted. "own" and "unattributed" are
  // offerable; "other-business" is what the send path refuses, and saying so
  // here means the picker can grey it out instead of letting somebody choose it
  // and meet a 422 they did not expect.
  const annotated = templates
    // Another system's templates, suppressed by name — never offered and never
    // counted towards canSend. A row may linger until the next sync retires it.
    .filter((template) => !isHiddenTemplate(template.metaTemplateName))
    .map((template) => ({
      ...template,
      attribution: attributeTemplate(template.metaTemplateName, organization.slug),
    }));

  return c.json({
    templates: annotated,
    broadcasts,
    reachable,
    // Approved is not enough on its own. This used to read `some(isApproved)`,
    // which was true for every business on this deployment the moment any
    // template anywhere on the account was approved — including four belonging
    // to other companies and two left by an unrelated integration.
    canSend:
      annotated.some(
        (template) => template.isApproved && template.attribution !== "other-business"
      ) && reachable > 0,
  });
});

// Re-reads this business's templates from Meta. Exposed as an explicit action
// because approval happens on Meta's schedule, not ours: an owner who has just
// been approved should not have to wait for the next scheduled sync to find out.
broadcastsRoute.post("/:slug/sync", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  if (!organization.whatsappBusinessAccountId) {
    return c.json({ error: "This business has no WhatsApp account connected" }, 422);
  }

  try {
    const result = await syncTemplatesForOrganization(organization);
    return c.json(result);
  } catch (err) {
    logger.error({ slug: organization.slug, err }, "Manual template sync failed");
    return c.json({ error: "Could not reach Meta. Try again shortly." }, 502);
  }
});

// Creates a broadcast in draft/scheduled state. Actually sending happens via
// POST /:id/send, kept as a separate step so a marketer can review the
// resolved audience count before committing to a bulk send.
broadcastsRoute.post("/", async (c) => {
  const body = await c
    .req.json<{ organizationSlug?: string; templateId?: string; audienceFilter?: AudienceFilter; scheduledAt?: string }>()
    .catch(() => null);
  if (!body?.organizationSlug || !body.templateId) {
    return c.json({ error: "organizationSlug and templateId are required" }, 400);
  }

  const organization = await findOrganizationBySlug(body.organizationSlug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const template = await getBroadcastTemplate(body.templateId);
  if (!template) return c.json({ error: "Template not found" }, 404);
  if (!template.isApproved) {
    return c.json({ error: "Template is not yet Meta-approved" }, 422);
  }

  // THE TEMPLATE ROW MUST BE THIS BUSINESS'S. It was fetched by id and nothing
  // compared it to the organization — the same defect the send path already
  // carries a test for, one route earlier: pairing broadcast A with B's row
  // resolved fine, returned 200, and put another company's message in front of
  // these customers.
  if (template.organizationId !== organization.id) {
    return c.json({ error: "That template belongs to a different business." }, 403);
  }

  // AND ITS NAME MUST NOT SPEAK FOR SOMEBODY ELSE. Passing the check above is
  // not enough on a shared WhatsApp account: a sync writes every template on
  // the account under every business, so ABR holds its own APPROVED copy of
  // `zipicka_order_update`. Meta approving a template says what it may send,
  // never who it is for.
  const attribution = attributeTemplate(template.metaTemplateName, organization.slug);
  if (attribution === "other-business") {
    return c.json(
      { error: describeWrongTemplate(template.metaTemplateName, organization.slug) },
      422
    );
  }

  const broadcast = await createBroadcast({
    organizationId: organization.id,
    templateId: body.templateId,
    audienceFilter: body.audienceFilter ?? {},
    scheduledAt: body.scheduledAt,
  });

  return c.json({ broadcast });
});

broadcastsRoute.post("/:id/send", async (c) => {
  const broadcastId = c.req.param("id");
  const body = await c.req.json<{ audienceFilter?: AudienceFilter }>().catch(() => null);

  // Organization and template come from the broadcast row, never from the
  // request. They used to be required parameters, which meant nothing verified
  // that the organization named matched the broadcast's own — a request pairing
  // broadcast A with organization B would have resolved B's entire contact list
  // as A's audience and messaged all of them.
  const broadcast = await getBroadcast(broadcastId);
  if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

  const [organization, template] = await Promise.all([
    findOrganizationById(broadcast.organizationId),
    getBroadcastTemplate(broadcast.templateId),
  ]);
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  if (!template) return c.json({ error: "Template not found" }, 404);
  // Checked at creation too, but a template can lose approval at Meta between
  // drafting and sending, and this is the last point before messages go out.
  if (!template.isApproved) {
    return c.json({ error: "Template is not yet Meta-approved" }, 422);
  }
  // Both attribution checks are repeated here for a different reason than
  // approval is. Approval can change at Meta; ownership cannot. What can exist
  // is a broadcast DRAFTED before these checks shipped, sitting in the table
  // with another business's template already chosen — and the send route is the
  // only thing standing between that row and a customer's phone.
  if (template.organizationId !== organization.id) {
    return c.json({ error: "That template belongs to a different business." }, 403);
  }
  if (attributeTemplate(template.metaTemplateName, organization.slug) === "other-business") {
    return c.json(
      { error: describeWrongTemplate(template.metaTemplateName, organization.slug) },
      422
    );
  }

  const contacts = await getContactsForAudience(broadcast.organizationId, body?.audienceFilter ?? broadcast.audienceFilter ?? {});
  if (contacts.length === 0) {
    return c.json({ error: "Audience filter matched zero contacts" }, 422);
  }

  const recipients = await createBroadcastRecipients(
    broadcastId,
    contacts.map((contact) => contact.id)
  );

  await updateBroadcastStatus(broadcastId, "sending");

  const queue = getBroadcastSendQueue();
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  await Promise.all(
    recipients.map((recipient) => {
      const contact = contactsById.get(recipient.contactId);
      if (!contact) return Promise.resolve();
      return queue.add("send", {
        broadcastId,
        recipientId: recipient.id,
        contactWaId: contact.waId,
        phoneNumberId: organization.whatsappPhoneNumberId,
        templateName: template.metaTemplateName,
        templateLanguage: template.language,
        templateParams: resolveTemplateParams(template.bodyParamCount, contact.displayName),
      });
    })
  );

  logger.info({ broadcastId, recipientCount: recipients.length }, "Broadcast send enqueued");
  return c.json({ broadcastId, enqueued: recipients.length });
});

/**
 * Fills a template's {{n}} placeholders for one recipient.
 *
 * Meta rejects a send whose parameter count differs from the approved body, so
 * the count comes from the template rather than from how much we happen to know
 * about the contact. The first placeholder is the person's name; any beyond it
 * are filled with a neutral value rather than left empty, because an empty
 * string is rejected as a missing parameter and would fail the whole send.
 *
 * Unnamed contacts get "there" — "Hello there" reads as written, where the
 * obvious alternative of substituting the phone number greets a customer with
 * their own number.
 */
function resolveTemplateParams(count: number, displayName: string | null): string[] {
  if (count <= 0) return [];
  const name = displayName?.trim() || "there";
  return Array.from({ length: count }, (_, index) => (index === 0 ? name : "-"));
}
