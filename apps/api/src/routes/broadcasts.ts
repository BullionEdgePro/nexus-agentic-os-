import { Hono } from "hono";
import {
  createBroadcast,
  getBroadcastTemplate,
  getContactsForAudience,
  createBroadcastRecipients,
  updateBroadcastStatus,
  findOrganizationBySlug,
  findOrganizationById,
} from "@nexus/db";
import type { AudienceFilter } from "@nexus/shared";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { logger } from "../lib/logger.js";

export const broadcastsRoute = new Hono();

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
  const body = await c
    .req.json<{ organizationId?: string; templateId?: string; audienceFilter?: AudienceFilter }>()
    .catch(() => null);

  // The broadcast row already has these fields; requiring them here too
  // keeps this endpoint simple (no extra read-then-branch) at the cost of
  // the caller re-supplying what POST / returned. Fine for an internal tool.
  if (!body?.organizationId || !body.templateId) {
    return c.json({ error: "organizationId and templateId are required" }, 400);
  }

  const [organization, template] = await Promise.all([
    findOrganizationById(body.organizationId),
    getBroadcastTemplate(body.templateId),
  ]);
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  if (!template) return c.json({ error: "Template not found" }, 404);

  const contacts = await getContactsForAudience(body.organizationId, body.audienceFilter ?? {});
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
      });
    })
  );

  logger.info({ broadcastId, recipientCount: recipients.length }, "Broadcast send enqueued");
  return c.json({ broadcastId, enqueued: recipients.length });
});
