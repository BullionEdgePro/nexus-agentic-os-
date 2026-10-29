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
  getSegment,
  segmentContacts,
  isWhatsAppNumberRetired,
  businessEmailAudience,
} from "@nexus/db";
import { resolveCampaignMailbox } from "../services/campaign-mailbox.js";
import { planEmailCampaign, queueEmailCampaign } from "../services/email-campaign-send.js";
import { resumeCampaign, stopCampaign } from "../services/campaign-control.js";
import { emailContentRefusal } from "./my-campaigns.js";
import type { AudienceFilter } from "@nexus/shared";
import { attributeTemplate, describeWrongTemplate, isHiddenTemplate, isStaffTemplate } from "@nexus/shared";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { syncTemplatesForOrganization } from "../services/template-sync.js";
import { logger } from "../lib/logger.js";
import { explainSendError } from "../lib/send-errors.js";
import { fetchTemplateText } from "../lib/template-text.js";

export const broadcastsRoute = new Hono();

/**
 * The words of one of this business's approved messages (29 Oct 2026), so the
 * owner reads what a campaign will say instead of choosing by Meta's name.
 * Owner only (the /api/broadcasts mount), this business's row only, and only a
 * message on the business's own WhatsApp account — the one it is sent from.
 */
broadcastsRoute.get("/:slug/templates/:id/text", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  const template = await getBroadcastTemplate(c.req.param("id"));
  if (
    !template ||
    template.organizationId !== organization.id ||
    isStaffTemplate(template.metaTemplateName) ||
    !template.whatsappBusinessAccountId ||
    template.whatsappBusinessAccountId !== organization.whatsappBusinessAccountId
  ) {
    return c.json({ error: "Template not found" }, 404);
  }
  const text = await fetchTemplateText(template.whatsappBusinessAccountId, template.metaTemplateName, template.language);
  if (!text) return c.json({ error: "WhatsApp did not return this message's wording just now." }, 502);
  return c.json({ text, bodyParamCount: template.bodyParamCount });
});

// Everything a bulk send needs before one can be composed: the templates
// registered for this business, past sends, and how many contacts are actually
// reachable. Returned together because the page is useless without all three —
// a compose form with no template list and no audience count is a form that
// can only fail.
broadcastsRoute.get("/:slug", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const [templates, broadcasts, reachable, emailAudience, mailbox] = await Promise.all([
    listBroadcastTemplates(organization.id, organization.whatsappBusinessAccountId),
    listBroadcasts(organization.id),
    countReachableContacts(organization.id),
    businessEmailAudience(organization.id),
    resolveCampaignMailbox(organization.id, null),
  ]);
  const mailboxAddress = "error" in mailbox ? null : mailbox.address;

  // Every template on the shared WhatsApp account arrives under every business,
  // so the list is annotated rather than trusted. "own" and "unattributed" are
  // offerable; "other-business" is what the send path refuses, and saying so
  // here means the picker can grey it out instead of letting somebody choose it
  // and meet a 422 they did not expect.
  const annotated = templates
    // Another system's templates, suppressed by name — never offered and never
    // counted towards canSend. A row may linger until the next sync retires it.
    .filter((template) => !isHiddenTemplate(template.metaTemplateName))
    // A staff member's own message is theirs alone, not the business's
    // (28 Oct 2026) — it goes out under their name, from My campaigns.
    .filter((template) => !isStaffTemplate(template.metaTemplateName))
    .map((template) => ({
      ...template,
      attribution: attributeTemplate(template.metaTemplateName, organization.slug),
    }));

  return c.json({
    templates: annotated,
    // Meta's raw error bodies, in words — the staff history already did this.
    broadcasts: broadcasts.map((broadcast) => ({
      ...broadcast,
      failureReasons: [...new Set(broadcast.failureReasons.map(explainSendError))],
    })),
    reachable,
    // The email side (26 Oct 2026): everyone the business can email, from the
    // business mailbox, paced as it would actually go.
    email: {
      reachable: emailAudience.length,
      from: mailboxAddress,
      fromError: "error" in mailbox ? mailbox.error : null,
      plan: await planEmailCampaign(emailAudience.length, mailboxAddress),
    },
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

// An email campaign to everyone the business can reach by email (26 Oct 2026).
// Sent at once — there is no draft step, because there is no Meta approval to
// wait for — from the business mailbox, never from one employee's own address.
broadcastsRoute.post("/:slug/email", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const refused = emailContentRefusal(body.subject, body.body);
  if (refused) return c.json({ error: refused }, 400);

  const audience = await businessEmailAudience(organization.id);
  if (audience.length === 0) {
    return c.json({ error: "Nobody this business serves can be emailed — no addresses, or everyone unsubscribed." }, 422);
  }
  const mailbox = await resolveCampaignMailbox(organization.id, null);
  if ("error" in mailbox) return c.json({ error: mailbox.error }, 409);

  const queued = await queueEmailCampaign({
    organizationId: organization.id,
    employeeId: null,
    subject: body.subject.trim(),
    body: body.body.trim(),
    audience,
    mailbox,
  });
  return c.json({ ...queued, enqueued: audience.length, from: mailbox.address });
});

// Resume or stop any campaign of any business — an owner's controls, behind
// operatorOnly at the mount like everything under /api/broadcasts.
broadcastsRoute.post("/:id/resume", async (c) => {
  const result = await resumeCampaign(c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
});
broadcastsRoute.post("/:id/stop", async (c) => {
  const result = await stopCampaign(c.req.param("id"));
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

// Creates a broadcast in draft/scheduled state. Actually sending happens via
// POST /:id/send, kept as a separate step so a marketer can review the
// resolved audience count before committing to a bulk send.
broadcastsRoute.post("/", async (c) => {
  const body = await c
    .req.json<{
      organizationSlug?: string;
      templateId?: string;
      audienceFilter?: AudienceFilter;
      scheduledAt?: string;
      segmentId?: string;
    }>()
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
  if (isStaffTemplate(template.metaTemplateName)) {
    return c.json({ error: "That message belongs to one staff member and is sent from My campaigns." }, 403);
  }
  // A business broadcast goes out from the business's number, so its template
  // must be on the business's own WhatsApp account, not a staff number's
  // (migration 096). Meta would refuse it for every recipient otherwise.
  if (template.whatsappBusinessAccountId !== organization.whatsappBusinessAccountId) {
    return c.json(
      { error: "That template is approved on a staff member's own WhatsApp account, not this business's." },
      422
    );
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

  // A CUSTOMER LIST, by reference (migration 093). Stored as {"$segment": id}
  // so the list is evaluated at SEND time — whoever matches then, not whoever
  // matched when the draft was made. Checked to be this business's own list.
  let audienceFilter: AudienceFilter = body.audienceFilter ?? {};
  if (typeof body.segmentId === "string" && body.segmentId) {
    const segment = await getSegment(organization.id, body.segmentId);
    if (!segment) return c.json({ error: "That customer list does not exist for this business." }, 404);
    audienceFilter = { $segment: segment.id };
  }

  const broadcast = await createBroadcast({
    organizationId: organization.id,
    templateId: body.templateId,
    audienceFilter,
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
  // A business campaign leaves from the business's line. Once that line was
  // switched off at Meta there is nothing to send from — refuse before a single
  // recipient is queued, rather than fail them one by one at Meta.
  if (await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId)) {
    return c.json(
      {
        error:
          "This business's shared WhatsApp number was switched off, so a business campaign has nothing to send from. Staff can send campaigns from their own WhatsApp numbers.",
      },
      409
    );
  }
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
  if (isStaffTemplate(template.metaTemplateName)) {
    return c.json({ error: "That message belongs to one staff member and is sent from My campaigns." }, 403);
  }
  // A business broadcast goes out from the business's number, so its template
  // must be on the business's own WhatsApp account, not a staff number's
  // (migration 096). Meta would refuse it for every recipient otherwise.
  if (template.whatsappBusinessAccountId !== organization.whatsappBusinessAccountId) {
    return c.json(
      { error: "That template is approved on a staff member's own WhatsApp account, not this business's." },
      422
    );
  }
  if (attributeTemplate(template.metaTemplateName, organization.slug) === "other-business") {
    return c.json(
      { error: describeWrongTemplate(template.metaTemplateName, organization.slug) },
      422
    );
  }

  // Aimed at a customer list: evaluate it NOW, and refuse if it is gone — a
  // campaign whose list was deleted must never fall back to everyone.
  const segmentRef = (broadcast.audienceFilter as Record<string, unknown> | null)?.["$segment"];
  let contacts: Array<{ id: string; waId: string; displayName: string | null }>;
  if (typeof segmentRef === "string") {
    const segment = await getSegment(broadcast.organizationId, segmentRef);
    if (!segment) {
      return c.json(
        { error: "The customer list this campaign was aimed at has been deleted. Nothing was sent." },
        422
      );
    }
    contacts = await segmentContacts(broadcast.organizationId, segment.filter);
  } else {
    contacts = await getContactsForAudience(broadcast.organizationId, body?.audienceFilter ?? broadcast.audienceFilter ?? {});
  }
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
