import { Hono, type Context } from "hono";
import {
  findOrganizationBySlug,
  listEmployees,
  isWhatsAppNumberRetired,
  listBroadcastTemplates,
  getBroadcastTemplate,
  getContactsForAudience,
  lastInboundByContact,
  openWindowConversations,
  createAdminBroadcast,
  createBroadcastRecipients,
  updateBroadcastStatus,
  listBroadcasts,
  connectionSecret,
  insertOutboundMessage,
  isWaIdOptedOut,
  dailyReachUsed,
  withTenant,
} from "@nexus/db";
import { attributeTemplate, isHiddenTemplate } from "@nexus/shared";
import { readSendingHealth, readNumberStanding, sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { sendReplyOnChannel } from "../lib/reply-dispatch.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { fetchTemplateText } from "../lib/template-text.js";
import { noteTestSend, readTestSend } from "../lib/campaign-test-status.js";
import { readPaymentRefusal, notePaymentRefusal } from "../lib/payment-refusal.js";
import { explainSendError, isPaymentRefusal } from "../lib/send-errors.js";
import { actorOf } from "../lib/actor.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  chosenIds,
  personalise,
  staffTemplateParams,
  describeDailyCeiling,
  testSendRefusal,
  internationalDigits,
} from "./my-campaigns.js";

/**
 * Bulk messaging, for the admins only (30 Oct 2026).
 *
 * The owner decided that only the two admin accounts send in bulk; staff chat
 * one to one. So the pieces staff had on My campaigns — the client picker,
 * approved messages with their wording, quick messages inside the 24-hour
 * window, test sends — live here, with two choices staff never had: WHICH
 * number it goes from (any connected number of the business), and WHICH
 * customers (any of the business's, not one person's book).
 *
 * Mounted under /api/bulk behind operatorOnly. Every send re-reads the number,
 * the template and the audience server-side: the client sends ids, and ids
 * only ever narrow what this business may reach.
 */
export const adminBulkRoute = new Hono();

interface SendingNumber {
  phoneNumberId: string;
  label: string;
  /** The staff member whose number it is; null for the business's own number. */
  ownerEmployeeId: string | null;
  wabaId: string | null;
}

/** Every number this business can send from: staff numbers, then its own if still on. */
async function numbersOf(organization: {
  id: string;
  name?: string;
  slug: string;
  whatsappPhoneNumberId: string | null;
  whatsappBusinessAccountId: string | null;
}): Promise<SendingNumber[]> {
  const employees = await withTenant(organization.id, () => listEmployees(organization.id));
  const numbers: SendingNumber[] = employees
    .filter((employee) => employee.whatsappPhoneNumberId)
    .map((employee) => ({
      phoneNumberId: employee.whatsappPhoneNumberId as string,
      label: `${employee.fullName}${employee.whatsappNumber ? ` · ${employee.whatsappNumber}` : ""}`,
      ownerEmployeeId: employee.id,
      wabaId: employee.whatsappBusinessAccountId ?? organization.whatsappBusinessAccountId,
    }));
  if (organization.whatsappPhoneNumberId && !(await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId))) {
    numbers.push({
      phoneNumberId: organization.whatsappPhoneNumberId,
      label: "The business's own number",
      ownerEmployeeId: null,
      wabaId: organization.whatsappBusinessAccountId,
    });
  }
  return numbers;
}

/** The organization and the chosen number, or why not. */
async function resolve(c: Context, phoneNumberId: string | null) {
  const organization = await findOrganizationBySlug(c.req.param("slug") ?? "");
  if (!organization) return { error: "Business not found.", status: 404 as const };
  const numbers = await numbersOf(organization);
  if (!phoneNumberId) return { organization, numbers, number: null };
  const number = numbers.find((candidate) => candidate.phoneNumberId === phoneNumberId);
  if (!number) return { error: "That number is not one of this business's connected numbers.", status: 422 as const };
  return { organization, numbers, number };
}

/** The token that may read templates on the number's account. */
async function tokenFor(organizationId: string, number: SendingNumber, businessWaba: string | null): Promise<string> {
  if (number.ownerEmployeeId && number.wabaId && number.wabaId !== businessWaba) {
    const secret = await withTenant(organizationId, () =>
      connectionSecret(organizationId, number.ownerEmployeeId as string, "whatsapp")
    ).catch(() => null);
    if (secret) return secret.accessToken;
  }
  return env.metaAccessToken;
}

/** The business's customers who can be reached on WhatsApp, with when they last wrote to this number. */
async function customersFor(organizationId: string, phoneNumberId: string) {
  const customers = await withTenant(organizationId, () => getContactsForAudience(organizationId, {}));
  const lastWrote = await lastInboundByContact(organizationId, phoneNumberId, customers.map((c) => c.id));
  return customers.map((customer) => ({ ...customer, lastInboundAt: lastWrote.get(customer.id) ?? null }));
}

/** Approved messages on the number's account that speak for this business. */
async function templatesFor(organization: { id: string; slug: string }, wabaId: string | null) {
  const templates = await withTenant(organization.id, () => listBroadcastTemplates(organization.id, wabaId));
  return templates
    .filter((template) => template.isApproved)
    .filter((template) => !isHiddenTemplate(template.metaTemplateName))
    .filter((template) => attributeTemplate(template.metaTemplateName, organization.slug) !== "other-business")
    .map((template) => ({
      id: template.id,
      name: template.metaTemplateName,
      language: template.language,
      bodyParamCount: template.bodyParamCount,
    }));
}

/** The business's numbers, and its recent campaigns. */
adminBulkRoute.get("/:slug", async (c) => {
  const resolved = await resolve(c, null);
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const campaigns = await withTenant(resolved.organization.id, () => listBroadcasts(resolved.organization.id));
  return c.json({
    numbers: resolved.numbers.map(({ phoneNumberId, label, ownerEmployeeId }) => ({ phoneNumberId, label, isStaffNumber: Boolean(ownerEmployeeId) })),
    campaigns: campaigns.slice(0, 15).map((campaign) => ({
      ...campaign,
      failureReasons: [...new Set(campaign.failureReasons.map(explainSendError))],
    })),
  });
});

/**
 * Everything needed to send from one number: its approved messages, the
 * business's customers with when each last wrote to it, and whether WhatsApp
 * will let it send right now.
 */
adminBulkRoute.get("/:slug/number/:phoneNumberId", async (c) => {
  const resolved = await resolve(c, c.req.param("phoneNumberId"));
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { organization, number } = resolved;
  if (!number) return c.json({ error: "Choose a number." }, 400);

  const [templates, customers, health, refused, standing, usedToday] = await Promise.all([
    templatesFor(organization, number.wabaId),
    customersFor(organization.id, number.phoneNumberId),
    readSendingHealth(number.phoneNumberId),
    readPaymentRefusal(number.phoneNumberId),
    readNumberStanding(number.phoneNumberId),
    // A floor: counted from campaign recipients only (see describeDailyCeiling).
    dailyReachUsed(number.phoneNumberId).catch(() => null),
  ]);
  const blocked = health?.problem?.description ?? (refused ? "WhatsApp refused this number's last message over payment — fix the card, then send a test." : null);
  return c.json({
    templates,
    customers,
    canSend: !blocked && standing?.quality !== "RED",
    blocked: blocked ?? (standing?.quality === "RED" ? "WhatsApp rates this number's quality as low (red)." : null),
    dailyLimit: standing?.dailyLimit ?? null,
    usedToday,
  });
});

/** The words of an approved message on the chosen number's account. */
adminBulkRoute.get("/:slug/number/:phoneNumberId/templates/:id/text", async (c) => {
  const resolved = await resolve(c, c.req.param("phoneNumberId"));
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { organization, number } = resolved;
  if (!number) return c.json({ error: "Choose a number." }, 400);
  const template = await withTenant(organization.id, () => getBroadcastTemplate(c.req.param("id")));
  if (!template || template.organizationId !== organization.id || template.whatsappBusinessAccountId !== number.wabaId) {
    return c.json({ error: "Message not found." }, 404);
  }
  const token = await tokenFor(organization.id, number, organization.whatsappBusinessAccountId);
  const text = await fetchTemplateText(number.wabaId as string, template.metaTemplateName, template.language, token);
  if (!text) return c.json({ error: "WhatsApp did not return this message's wording just now." }, 502);
  return c.json({ text, bodyParamCount: template.bodyParamCount });
});

/** The approved message, its number, and the narrowed audience — or why not. */
async function prepareSend(c: Context, body: { phoneNumberId?: unknown; templateId?: unknown; contactIds?: unknown }) {
  const phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId : null;
  if (!phoneNumberId) return { error: "Choose the number to send from.", status: 400 as const };
  const resolved = await resolve(c, phoneNumberId);
  if ("error" in resolved) return { error: resolved.error as string, status: resolved.status };
  const { organization, number } = resolved;
  if (!number) return { error: "Choose the number to send from.", status: 400 as const };
  const templateId = typeof body.templateId === "string" ? body.templateId : null;
  if (!templateId) return { error: "Choose an approved message.", status: 400 as const };
  const template = await withTenant(organization.id, () => getBroadcastTemplate(templateId));
  if (!template || template.organizationId !== organization.id) return { error: "That message no longer exists.", status: 404 as const };
  if (!template.isApproved) return { error: "WhatsApp has not approved that message.", status: 422 as const };
  if (template.whatsappBusinessAccountId !== number.wabaId) {
    return { error: "That message is approved on a different WhatsApp account from this number. Choose one listed for it.", status: 422 as const };
  }
  if (attributeTemplate(template.metaTemplateName, organization.slug) === "other-business") {
    return { error: "That message speaks for a different business.", status: 422 as const };
  }
  return { organization, number, template, chosen: chosenIds(body.contactIds) };
}

/**
 * Send an approved message to the chosen customers, from the chosen number.
 * Refused whole when WhatsApp is blocking the number; the ceiling is reported,
 * as on the staff send, never trimmed.
 */
adminBulkRoute.post("/:slug/send", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prepared = await prepareSend(c, body);
  if ("error" in prepared) return c.json({ error: prepared.error }, prepared.status);
  const { organization, number, template, chosen } = prepared;
  if (!chosen || chosen.size === 0) return c.json({ error: "Choose at least one customer." }, 400);

  const customers = await withTenant(organization.id, () => getContactsForAudience(organization.id, {}));
  const audience = customers.filter((customer) => chosen.has(customer.id));
  if (audience.length === 0) return c.json({ error: "None of the chosen customers can be messaged." }, 422);

  const [health, refused, standing] = await Promise.all([
    readSendingHealth(number.phoneNumberId),
    readPaymentRefusal(number.phoneNumberId),
    readNumberStanding(number.phoneNumberId),
  ]);
  if (health?.problem) return c.json({ error: `WhatsApp is blocking this number: ${health.problem.description}` }, 409);
  if (refused) return c.json({ error: "WhatsApp refused this number's last message over payment. Fix the card and send a test first." }, 409);
  if (standing?.quality === "RED") return c.json({ error: "WhatsApp rates this number's quality as low (red). Nothing was sent." }, 409);

  const actor = await actorOf(c);
  const ceiling = await describeDailyCeiling(audience.length, number.phoneNumberId);
  const broadcast = await withTenant(organization.id, () =>
    createAdminBroadcast({
      organizationId: organization.id,
      templateId: (body as { templateId: string }).templateId,
      fromPhoneNumberId: number.phoneNumberId,
      numberOwnerEmployeeId: number.ownerEmployeeId,
      sentBy: actor.name,
      recipients: audience.length,
    })
  );
  const recipients = await withTenant(organization.id, () =>
    createBroadcastRecipients(broadcast.id, audience.map((person) => person.id))
  );
  await withTenant(organization.id, () => updateBroadcastStatus(broadcast.id, "sending"));

  const queue = getBroadcastSendQueue();
  const byId = new Map(audience.map((person) => [person.id, person]));
  await Promise.all(
    recipients.map((recipient) => {
      const person = byId.get(recipient.contactId);
      if (!person) return Promise.resolve();
      return queue.add("send", {
        broadcastId: broadcast.id,
        recipientId: recipient.id,
        contactWaId: person.waId,
        phoneNumberId: number.phoneNumberId,
        templateName: template.metaTemplateName,
        templateLanguage: template.language,
        templateParams: staffTemplateParams(template.bodyParamCount, person.displayName),
      });
    })
  );
  logger.info(
    { organization: organization.slug, broadcastId: broadcast.id, from: number.phoneNumberId, recipients: recipients.length, by: actor.name },
    "Admin bulk campaign enqueued"
  );
  return c.json({ broadcastId: broadcast.id, enqueued: recipients.length, dailyCeiling: ceiling });
});

/**
 * Free text, now, to the chosen customers who wrote to this number in the last
 * 24 hours — sent and recorded as ordinary replies in their conversations.
 */
adminBulkRoute.post("/:slug/quick", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Write the message." }, 400);
  if (text.length > 4096) return c.json({ error: "Keep the message under 4,096 characters." }, 400);
  const resolved = await resolve(c, typeof body.phoneNumberId === "string" ? body.phoneNumberId : null);
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { organization, number } = resolved;
  if (!number) return c.json({ error: "Choose the number to send from." }, 400);
  const chosen = chosenIds(body.contactIds);
  if (!chosen || chosen.size === 0) return c.json({ error: "Choose at least one customer." }, 400);

  const customers = (await withTenant(organization.id, () => getContactsForAudience(organization.id, {}))).filter((customer) =>
    chosen.has(customer.id)
  );
  const open = await openWindowConversations(organization.id, number.phoneNumberId, customers.map((customer) => customer.id));
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const people = open.flatMap((window) => {
    const person = byId.get(window.contactId);
    return person ? [{ ...person, conversationId: window.conversationId }] : [];
  }).slice(0, 200);
  if (people.length === 0) {
    return c.json({ error: "None of the chosen customers wrote to this number in the last 24 hours. Send an approved message instead." }, 422);
  }

  const actor = await actorOf(c);
  const sent: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const person of people) {
    const message = personalise(text, person.displayName);
    try {
      const dispatched = await sendReplyOnChannel(
        {
          organizationId: organization.id,
          channel: "whatsapp",
          phoneNumberId: number.phoneNumberId,
          contactWaId: person.waId,
          contactExternalId: null,
          conversationId: person.conversationId,
        },
        message
      );
      const recorded = await withTenant(organization.id, () =>
        insertOutboundMessage({
          organizationId: organization.id,
          conversationId: person.conversationId,
          contactId: person.id,
          senderType: "human_agent",
          senderId: actor.id ?? undefined,
          employeeId: number.ownerEmployeeId,
          body: message,
          waMessageId: dispatched.waMessageId ?? undefined,
        })
      );
      await publishInboxEvent({
        type: "message",
        organizationId: organization.id,
        organizationSlug: organization.slug,
        conversationId: person.conversationId,
        message: { ...recorded, senderName: actor.name },
      }).catch(() => undefined);
      sent.push(person.displayName ?? `+${person.waId}`);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (isPaymentRefusal(raw)) await notePaymentRefusal(number.phoneNumberId, raw).catch(() => undefined);
      failed.push({ name: person.displayName ?? `+${person.waId}`, reason: explainSendError(raw) });
    }
  }
  logger.info({ organization: organization.slug, from: number.phoneNumberId, sent: sent.length, failed: failed.length, by: actor.name }, "Admin quick message sent");
  return c.json({ sent: sent.length, failed });
});

/** One copy of an approved message to one number, from the chosen number. */
adminBulkRoute.post("/:slug/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prepared = await prepareSend(c, body);
  if ("error" in prepared) return c.json({ error: prepared.error }, prepared.status);
  const { number, template } = prepared;
  const to = typeof body.to === "string" ? body.to.trim().slice(0, 40) : "";
  if (!to) return c.json({ error: "Which number should the test go to?" }, 400);
  const refusedTo = testSendRefusal(to, null);
  if (refusedTo) return c.json({ error: refusedTo }, 400);
  const toDigits = internationalDigits(to);
  if (await isWaIdOptedOut(toDigits)) return c.json({ error: "That number belongs to someone who asked not to be messaged." }, 400);

  const actor = await actorOf(c);
  try {
    const messageId = await sendWhatsAppTemplate(
      number.phoneNumberId,
      toDigits,
      template.metaTemplateName,
      template.language,
      staffTemplateParams(template.bodyParamCount, actor.name)
    );
    if (messageId && actor.id) await noteTestSend(messageId, actor.id).catch(() => undefined);
    return c.json({ ok: true, messageId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (isPaymentRefusal(raw)) await notePaymentRefusal(number.phoneNumberId, raw).catch(() => undefined);
    return c.json({ error: explainSendError(raw) }, 502);
  }
});

/** What WhatsApp did with an admin's test, once it has said. */
adminBulkRoute.get("/test/:messageId", async (c) => {
  const actor = await actorOf(c);
  const status = await readTestSend(c.req.param("messageId")).catch(() => null);
  if (!status || !actor.id || status.employeeId !== actor.id) return c.json({ error: "No such test." }, 404);
  return c.json({ state: status.state, reason: status.reason ? explainSendError(status.reason) : null, at: status.at });
});
