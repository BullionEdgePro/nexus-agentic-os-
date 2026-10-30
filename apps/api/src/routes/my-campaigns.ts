import { Hono, type Context } from "hono";
import type { SessionScope } from "../lib/session.js";
import {
  findEmployeeById,
  findOrganizationById,
  withTenant,
  claimPhoneNumber,
  releasePhoneNumber,
  createStaffBroadcast,
  myClientsForBroadcast,
  listMyBroadcasts,
  broadcastAllowanceRemaining,
  listBroadcastTemplates,
  dailyReachUsed,
  getBroadcastTemplate,
  createBroadcastRecipients,
  updateBroadcastStatus,
  isWhatsAppNumberRetired,
  isWaIdOptedOut,
  myClientsForEmailCampaign,
  campaignForControl,
  connectionSecret,
  upsertTemplateFromMeta,
  openWindowConversations,
  lastInboundByContact,
  insertOutboundMessage,
} from "@nexus/db";
import { sendReplyOnChannel } from "../lib/reply-dispatch.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { fetchTemplateText } from "../lib/template-text.js";
import { completeText } from "@nexus/agents";
import { renderCampaignEmail, explainEmailSendError } from "../lib/campaign-email.js";
import { apiBaseUrl } from "../lib/public-urls.js";
import { unsubscribeUrl } from "./unsubscribe.js";
import { resolveCampaignMailbox, sendFromMailbox } from "../services/campaign-mailbox.js";
import { planEmailCampaign, queueEmailCampaign } from "../services/email-campaign-send.js";
import { resumeCampaign, stopCampaign } from "../services/campaign-control.js";
import {
  attributeTemplate,
  describeWrongTemplate,
  isHiddenTemplate,
  staffMayUseTemplate,
  staffTemplateBody,
  staffTemplateLabel,
  staffTemplateName,
  staffTemplatePrefix,
} from "@nexus/shared";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { createMetaTemplate, listWabaNumbers, readNumberStanding, sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { noteTestSend, readTestSend } from "../lib/campaign-test-status.js";
import { syncStaffAccountTemplates, syncTemplatesForOrganization } from "../services/template-sync.js";
import { env } from "../config/env.js";
import { deskOf, text } from "./my-desk.js";
import { campaignReadiness, sendingAccountOf } from "../services/campaign-readiness.js";
import { logger } from "../lib/logger.js";
import { explainSendError, isPaymentRefusal } from "../lib/send-errors.js";
import { notePaymentRefusal } from "../lib/payment-refusal.js";

/**
 * A staff member's own number, and campaigns to their own book.
 *
 * Split from my-desk.ts, which holds the client book itself. Same prefix, same
 * `deskOf` boundary: every handler resolves the person from the SESSION, and
 * nothing here accepts an employee id from the caller.
 */
export const myCampaignsRoute = new Hono();

/**
 * BULK MESSAGING IS THE ADMINS' ALONE (30 Oct 2026). The owner moved every
 * bulk send — campaigns, quick messages, tests, email campaigns, writing
 * templates, claiming a number — to the two admin accounts (routes/admin-bulk.ts).
 * Refused here, on the server, for every staff request that would change or
 * send anything, so a hidden screen is not the only thing standing in the way.
 * Reads stay open: they send nothing.
 */
export const STAFF_BULK_OFF = "Bulk messaging is done by the admins now. Chat with your clients one to one in the inbox.";
// Named paths, never "*": this router is mounted at /api/my beside my-desk and
// my-day, and a catch-all here would refuse their writes too.
export const STAFF_BULK_PATHS = ["/channel/*", "/campaigns", "/campaigns/*", "/quick-message", "/templates", "/templates/*"];
for (const path of STAFF_BULK_PATHS) {
  myCampaignsRoute.use(path, async (c, next) => {
    if (c.req.method !== "GET") return c.json({ error: STAFF_BULK_OFF }, 403);
    await next();
  });
}

// ============================================================
// Claiming a number
// ============================================================

/**
 * Take one of the business account's numbers as your own.
 *
 * There is deliberately NO endpoint for typing a number in. A number the
 * platform has not found on the WhatsApp Business Account cannot send anything,
 * and storing one anyway produces a campaign that reports "queued" to a whole
 * client book and delivers to nobody. So the only way in is to pick from what
 * Meta actually holds — and the check is repeated here rather than trusted from
 * whatever the page was showing, because between rendering a list and clicking
 * a button a number can be removed at Meta.
 */
myCampaignsRoute.post("/channel/claim", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const phoneNumberId = text(body.phoneNumberId, 64);
  if (!phoneNumberId) return c.json({ error: "Which number?" }, 400);

  const organization = await withTenant(desk.organizationId, () =>
    findOrganizationById(desk.organizationId)
  );
  if (!organization) return c.json({ error: "Business not found." }, 404);

  let numbers;
  try {
    numbers = await listWabaNumbers(organization.whatsappBusinessAccountId);
  } catch (err) {
    logger.warn({ err }, "Could not verify a claimed number against Meta");
    return c.json(
      { error: "WhatsApp could not be reached, so this could not be verified. Nothing has changed." },
      502
    );
  }

  const number = numbers.find((candidate) => candidate.phoneNumberId === phoneNumberId);
  if (!number) {
    return c.json(
      { error: "WhatsApp does not hold that number on this business, so nothing could send from it." },
      422
    );
  }

  // The company's own number is not claimable. One person owning the line every
  // business answers on would route every inbound message to them.
  if (number.phoneNumberId === organization.whatsappPhoneNumberId) {
    return c.json(
      { error: "That is the shared company number. It belongs to the business, not to a person." },
      422
    );
  }

  const claimed = await withTenant(desk.organizationId, () =>
    claimPhoneNumber({
      organizationId: desk.organizationId,
      employeeId: desk.employeeId,
      phoneNumberId,
      displayNumber: number.displayPhoneNumber,
      verifiedName: number.verifiedName,
      qualityRating: number.qualityRating,
    })
  );
  if (!claimed.ok) return c.json({ error: `${claimed.heldBy} already has that number.` }, 409);

  logger.info(
    { employeeId: desk.employeeId, phoneNumberId },
    "Staff member claimed a WhatsApp number"
  );
  return c.json({ ok: true });
});

myCampaignsRoute.post("/channel/release", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  await withTenant(desk.organizationId, () =>
    releasePhoneNumber(desk.organizationId, desk.employeeId)
  );
  return c.json({ ok: true });
});

// ============================================================
// Campaigns to your own book
// ============================================================

myCampaignsRoute.get("/campaigns", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const organization = await withTenant(desk.organizationId, () =>
    findOrganizationById(desk.organizationId)
  );
  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  if (!organization || !employee) return c.json({ error: "Account not found." }, 404);

  // Failure reasons arrive as Meta's raw bodies; each is explained here so the
  // screen shows a sentence, and identical explanations are merged.
  const campaigns = (await withTenant(desk.organizationId, () => listMyBroadcasts(desk.employeeId))).map(
    (campaign) => {
      const merged = new Map<string, number>();
      for (const failure of campaign.topFailures) {
        const reason = explainSendError(failure.reason);
        merged.set(reason, (merged.get(reason) ?? 0) + failure.count);
      }
      return { ...campaign, topFailures: [...merged].map(([reason, count]) => ({ reason, count })) };
    }
  );
  const audience = await withTenant(desk.organizationId, () =>
    myClientsForBroadcast(desk.organizationId, desk.employeeId)
  );
  // Only templates on the WhatsApp account the campaign will go out from: a
  // template on another account is refused by Meta for every recipient.
  const sendingAccount = sendingAccountOf(employee, organization);
  const templates = await withTenant(desk.organizationId, () =>
    listBroadcastTemplates(desk.organizationId, sendingAccount)
  );
  const allowance = await broadcastAllowanceRemaining(
    desk.employeeId,
    employee.broadcastMonthlyCap ?? null
  );

  // What the NUMBER can still start today, shared across all six businesses.
  // Reported on the way in, not only after a send: a person deciding whether to
  // message four hundred people should see the ceiling while they decide.
  const retired = await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId);
  const sendingNumber = employee.whatsappPhoneNumberId ?? (retired ? null : organization.whatsappPhoneNumberId);
  const ceiling = await describeDailyCeiling(audience.length, sendingNumber);
  // Said on the way in, like the ceiling: someone deciding whether to send
  // should know WhatsApp's view of the number before they press anything.
  const quality = sendingNumber ? (await readNumberStanding(sendingNumber))?.quality ?? null : null;
  const healthWarning =
    quality === "RED"
      ? "WhatsApp rates this number's quality as low (red), so campaigns from it are stopped until the rating recovers."
      : quality === "YELLOW"
        ? "WhatsApp rates this number's quality as medium (yellow). Send only to people who expect to hear from you."
        : null;

  const readiness = await campaignReadiness(desk.employeeId, desk.organizationId);

  // THE EMAIL SIDE (26 Oct 2026): who in the book can be emailed, from which
  // mailbox, and how the list would be paced — said before anything is written.
  const emailAudience = await withTenant(desk.organizationId, () =>
    myClientsForEmailCampaign(desk.organizationId, desk.employeeId)
  );
  const mailbox = await resolveCampaignMailbox(desk.organizationId, desk.employeeId);
  const mailboxAddress = "error" in mailbox ? null : mailbox.address;

  return c.json({
    campaigns,
    readiness,
    email: {
      reachable: emailAudience.length,
      from: mailboxAddress,
      fromOwn: "error" in mailbox ? false : mailbox.employeeId !== null,
      fromError: "error" in mailbox ? mailbox.error : null,
      plan: await planEmailCampaign(emailAudience.length, mailboxAddress),
      audience: emailAudience.map((person) => ({ displayName: person.displayName, email: person.email })),
      senderName: employee.fullName,
    },
    canBroadcast: employee.canBroadcast ?? false,
    allowance,
    dailyCeiling: ceiling,
    healthWarning,
    sendsFrom: employee.whatsappPhoneNumberId
      ? "your own number"
      : (await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId))
        ? "nothing yet — connect your own WhatsApp first"
        : "the shared company number",
    // The names, not only the count. A number is the thing somebody clicks send
    // on without reading; a list of names is one they check first.
    // With the id and when they last wrote (30 Oct 2026), so the Clients tab can
    // pick and filter; a send can then name exactly who it is for.
    audience: await (async () => {
      const lastWrote = employee.whatsappPhoneNumberId
        ? await lastInboundByContact(desk.organizationId, employee.whatsappPhoneNumberId, audience.map((p) => p.id))
        : new Map<string, string>();
      return audience.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        waId: person.waId,
        lastInboundAt: lastWrote.get(person.id) ?? null,
      }));
    })(),
    // Approved, and speaking for THIS business. The same attribution check the
    // business broadcast route makes: on a shared WhatsApp account every
    // business holds a copy of every template, and Meta approving one says what
    // it may send, never who it is for.
    templates: templates
      .filter((template) => template.isApproved)
      .filter((template) => !isHiddenTemplate(template.metaTemplateName))
      // A colleague's own message is theirs alone (28 Oct 2026).
      .filter((template) => staffMayUseTemplate(template.metaTemplateName, desk.employeeId))
      .filter(
        (template) =>
          attributeTemplate(template.metaTemplateName, organization.slug) !== "other-business"
      )
      .map((template) => ({
        id: template.id,
        name: template.metaTemplateName,
        language: template.language,
        bodyParamCount: template.bodyParamCount,
      })),
    // The messages this person wrote, in every state — a message waiting for
    // Meta or refused by it is the one they most need to see.
    myTemplates: templates
      .filter((template) => template.metaTemplateName.startsWith(staffTemplatePrefix(desk.employeeId)))
      .map((template) => ({
        id: template.id,
        name: template.metaTemplateName,
        label: staffTemplateLabel(template.metaTemplateName),
        language: template.language,
        status: template.status ?? "PENDING",
        isApproved: template.isApproved,
      })),
    // What the client-list upload needs to put a file into THIS person's book.
    book: { businessSlug: organization.slug, employeeId: desk.employeeId },
    // Free-text messages, no approval (29 Oct 2026): only the clients who wrote
    // to this person's own number in the last 24 hours. See quickMessageAudience.
    quick: employee.whatsappPhoneNumberId
      ? {
          ownNumber: true,
          people: (await quickMessageAudience(desk.organizationId, employee.whatsappPhoneNumberId, audience)).map(
            (person) => ({ displayName: person.displayName, waId: person.waId, lastInboundAt: person.lastInboundAt })
          ),
        }
      : { ownNumber: false, people: [] },
  });
});

// ============================================================
// Quick message: free text inside WhatsApp's 24-hour window (29 Oct 2026)
// ============================================================

/**
 * The people in this book a free-text message can reach right now.
 *
 * WhatsApp's rule, not ours: a business may send anything without an approved
 * template only within 24 hours of the customer's last message to that number.
 * Outside it Meta refuses (131047). So a quick message goes only to these,
 * from the person's own number — on the shared line the window belongs to
 * whichever business answered, which is not this person's to spend.
 */
async function quickMessageAudience(
  organizationId: string,
  phoneNumberId: string,
  book: Array<{ id: string; waId: string; displayName: string | null }>
) {
  const open = await openWindowConversations(organizationId, phoneNumberId, book.map((person) => person.id));
  const byId = new Map(book.map((person) => [person.id, person]));
  return open.flatMap((window) => {
    const person = byId.get(window.contactId);
    return person ? [{ ...person, conversationId: window.conversationId, lastInboundAt: window.lastInboundAt }] : [];
  });
}

const QUICK_MESSAGE_MAX = 4096;
const QUICK_MESSAGE_RECIPIENTS_MAX = 200;

/**
 * The client ids a send was narrowed to, or null for "the whole book". At most
 * 2,000, strings only — anything else in the list is dropped, never trusted.
 * Exported for its test.
 */
export function chosenIds(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw)) return null;
  return new Set(raw.filter((id): id is string => typeof id === "string" && id.length <= 64).slice(0, 2000));
}

/** {name} → the recipient's first name, or "there". Exported for its test. */
export function personalise(text: string, displayName: string | null): string {
  const first = displayName?.trim().split(/\s+/)[0] || "there";
  return text.replace(/\{name\}/gi, first);
}

/**
 * Send one free-text message to everyone in the window, now.
 *
 * Each goes out as an ordinary reply in that client's conversation — the same
 * send and the same record as typing it in the inbox — so it shows in the
 * thread, gets delivery receipts, and never touches the campaign tables (a
 * WhatsApp campaign row must name a template). The window is re-read here, at
 * send time, so a list on screen for an hour cannot reach people whose window
 * has since closed. The AI's state is left alone: a broadcast is not a person
 * taking one conversation over.
 */
myCampaignsRoute.post("/quick-message", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Write the message." }, 400);
  if (text.length > QUICK_MESSAGE_MAX) return c.json({ error: "Keep the message under 4,096 characters." }, 400);

  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  if (!employee) return c.json({ error: "Account not found." }, 404);
  if (!employee.canBroadcast) return c.json({ error: "Campaigns are not switched on for you." }, 403);
  const from = employee.whatsappPhoneNumberId;
  if (!from) {
    return c.json({ error: "Quick messages go from your own WhatsApp number. Connect it in Connections first." }, 409);
  }

  const wholeBook = await withTenant(desk.organizationId, () => myClientsForBroadcast(desk.organizationId, desk.employeeId));
  // Chosen clients only, when the Clients tab named some (30 Oct 2026).
  const chosen = chosenIds(body.contactIds);
  if (chosen && chosen.size === 0) return c.json({ error: "Choose at least one client." }, 400);
  const book = chosen ? wholeBook.filter((person) => chosen.has(person.id)) : wholeBook;
  const people = (await quickMessageAudience(desk.organizationId, from, book)).slice(0, QUICK_MESSAGE_RECIPIENTS_MAX);
  if (people.length === 0 && chosen) {
    return c.json(
      { error: "None of the chosen clients has written to your WhatsApp in the last 24 hours. Send them an approved message instead." },
      422
    );
  }
  if (people.length === 0) {
    return c.json(
      { error: "Nobody in your book has written to your WhatsApp in the last 24 hours, so a free message cannot reach anyone. Use an approved message instead." },
      422
    );
  }

  const organization = await withTenant(desk.organizationId, () => findOrganizationById(desk.organizationId));
  const sent: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const person of people) {
    const message = personalise(text, person.displayName);
    try {
      const dispatched = await sendReplyOnChannel(
        {
          organizationId: desk.organizationId,
          channel: "whatsapp",
          phoneNumberId: from,
          contactWaId: person.waId,
          contactExternalId: null,
          conversationId: person.conversationId,
        },
        message
      );
      const recorded = await withTenant(desk.organizationId, () =>
        insertOutboundMessage({
          organizationId: desk.organizationId,
          conversationId: person.conversationId,
          contactId: person.id,
          senderType: "human_agent",
          senderId: desk.employeeId,
          employeeId: desk.employeeId,
          body: message,
          waMessageId: dispatched.waMessageId ?? undefined,
        })
      );
      if (organization) {
        await publishInboxEvent({
          type: "message",
          organizationId: desk.organizationId,
          organizationSlug: organization.slug,
          conversationId: person.conversationId,
          message: { ...recorded, senderName: employee.fullName },
        }).catch(() => undefined);
      }
      sent.push(person.displayName ?? `+${person.waId}`);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (isPaymentRefusal(raw)) await notePaymentRefusal(from, raw).catch(() => undefined);
      failed.push({ name: person.displayName ?? `+${person.waId}`, reason: explainSendError(raw) });
    }
  }

  logger.info(
    { employeeId: desk.employeeId, from, sent: sent.length, failed: failed.length },
    "Quick message sent to clients inside the 24-hour window"
  );
  return c.json({ sent: sent.length, failed });
});

/**
 * The words of an approved message, so a person can read what they are about
 * to send before they send it (29 Oct 2026). Only a message this person may
 * send, on the account they send from — the same checks the send makes.
 */
myCampaignsRoute.get("/templates/:id/text", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  // Read straight from the session as well, as controlOwnCampaign does.
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope || scope.role !== "employee" || scope.organizationId !== desk.organizationId) {
    return c.json({ error: "Message not found." }, 404);
  }
  const template = await withTenant(desk.organizationId, () => getBroadcastTemplate(c.req.param("id")));
  if (
    !template ||
    template.organizationId !== desk.organizationId ||
    !staffMayUseTemplate(template.metaTemplateName, desk.employeeId)
  ) {
    return c.json({ error: "Message not found." }, 404);
  }
  const account = await templateAccountFor(desk);
  if ("error" in account) return c.json({ error: account.error }, account.status);
  if (template.whatsappBusinessAccountId !== account.wabaId) return c.json({ error: "Message not found." }, 404);
  const text = await fetchTemplateText(account.wabaId, template.metaTemplateName, template.language, account.token);
  if (!text) return c.json({ error: "WhatsApp did not return this message's wording just now." }, 502);
  return c.json({ text, bodyParamCount: template.bodyParamCount });
});

/**
 * Send one.
 *
 * ============================================================
 * WHERE THE CEILING IS CHECKED, AND WHY IT REFUSES WHOLE
 * ============================================================
 *
 * Checked here, against the audience actually resolved, immediately before the
 * recipient rows are written. At draft time it would be checking a number
 * nobody is committed to; in the worker it would be checking after the rows
 * exist and the money is spent. The recipient rows are what cost, so they are
 * what is counted and what is capped.
 *
 * A campaign over the ceiling is REFUSED WHOLE rather than trimmed to fit.
 * Sending to the first eighty of a hundred clients is worse than sending to
 * none: the twenty dropped are invisible, and the sender believes the whole
 * book was reached.
 */
myCampaignsRoute.post("/campaigns", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const templateId = text(body.templateId, 64);
  if (!templateId) return c.json({ error: "Choose a message to send." }, 400);

  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  const organization = await withTenant(desk.organizationId, () =>
    findOrganizationById(desk.organizationId)
  );
  if (!employee || !organization) return c.json({ error: "Account not found." }, 404);

  if (!employee.canBroadcast) {
    return c.json(
      {
        error:
          "You cannot send campaigns yet. The owner turns this on per person, because a bulk send spends the shared number's standing with WhatsApp — which every business here depends on to get its real replies delivered.",
      },
      403
    );
  }

  // The same four checks the screen shows, so the two cannot disagree.
  const readiness = await campaignReadiness(desk.employeeId, desk.organizationId);
  if (readiness.some((c) => c.ok !== true)) {
    const first = readiness.find((c) => c.ok !== true)!;
    return c.json({ error: `${first.detail} ${first.fix ?? ""}`.trim(), readiness }, 422);
  }

  const template = await withTenant(desk.organizationId, () => getBroadcastTemplate(templateId));
  if (!template) return c.json({ error: "That message no longer exists." }, 404);
  const refusal = templateRefusal(template, organization, sendingAccountOf(employee, organization), desk.employeeId);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  const wholeBook = await withTenant(desk.organizationId, () =>
    myClientsForBroadcast(desk.organizationId, desk.employeeId)
  );
  // CHOSEN CLIENTS (30 Oct 2026): a send may name a subset, picked in the Clients
  // tab. Only ever narrowed to people already in the book — an id from anywhere
  // else is not somebody this person may message, so it is simply not in the list.
  const chosen = chosenIds(body.contactIds);
  if (chosen && chosen.size === 0) return c.json({ error: "Choose at least one client." }, 400);
  const audience = chosen ? wholeBook.filter((person) => chosen.has(person.id)) : wholeBook;
  if (audience.length === 0) {
    return c.json(
      {
        error: chosen
          ? "None of the chosen clients can be messaged — they may have left your book or asked not to be messaged."
          : "Nobody to send to. Either your book is empty, or everyone in it has asked not to be messaged.",
      },
      422
    );
  }

  // ONLY WHERE A CEILING WAS ACTUALLY CHOSEN.
  //
  // The cap is null for everyone by default now — the owner's decision, made
  // knowingly, recorded in migration 075. Where somebody HAS set one it still
  // refuses the campaign whole rather than trimming it, because the people
  // dropped from a trimmed send are invisible and the sender believes the whole
  // book was reached.
  const allowance = await broadcastAllowanceRemaining(
    desk.employeeId,
    employee.broadcastMonthlyCap ?? null
  );
  if (allowance.remaining !== null && audience.length > allowance.remaining) {
    return c.json(
      {
        error: `That would reach ${audience.length} people and you have ${allowance.remaining} left this month, of ${allowance.cap}. Nothing was sent — a campaign is not trimmed to fit, because the people dropped would be invisible.`,
      },
      429
    );
  }

  // THE CEILING THAT IS NOT OURS TO REMOVE, reported rather than enforced.
  //
  // Meta limits the NUMBER to its messaging tier per rolling 24 hours, shared
  // across all six businesses. A campaign larger than what is left does not
  // fail loudly — it sends until the ceiling and the rest quietly do not
  // arrive. The owner asked for no limitation and gets none from us; what they
  // must not get is a delivery report three days later revealing that a third
  // of the list was never reached.
  //
  // Logged at warn and returned to the caller, so the console can say it before
  // the send and afterwards.
  // Their own number when they have one, the company's when they do not.
  // Stamped onto the row so the answer to "what did this go out from" never
  // changes afterwards.
  const sharedRetired = await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId);
  const from = employee.whatsappPhoneNumberId ?? (sharedRetired ? null : organization.whatsappPhoneNumberId);
  if (!from) {
    return c.json(
      {
        error:
          "You have no WhatsApp number of your own yet, and the shared company number was switched off. Connect your WhatsApp Business number in Connections first.",
      },
      409
    );
  }

  // HOW WHATSAPP RATES THE NUMBER, asked before anything is written. RED means
  // recipients have been blocking or reporting it; sending more would spend the
  // rest of its standing, and it is the line this person's customers use.
  // YELLOW is allowed and said. An unanswered lookup is neither.
  const standing = await readNumberStanding(from);
  if (standing?.quality === "RED") {
    return c.json(
      {
        error:
          "WhatsApp rates this number's quality as low (red) — people have been blocking or reporting its messages. Nothing was sent. Wait for the rating to recover before another campaign.",
      },
      409
    );
  }
  const healthWarning =
    standing?.quality === "YELLOW"
      ? "WhatsApp rates this number's quality as medium (yellow). Send only to people who expect to hear from you."
      : null;

  const overDailyCeiling = await describeDailyCeiling(audience.length, from);
  if (overDailyCeiling) {
    logger.warn(
      { employeeId: desk.employeeId, audience: audience.length, ...overDailyCeiling },
      "Campaign is larger than the number can start today — sending anyway, per policy"
    );
  }


  const broadcast = await withTenant(desk.organizationId, () =>
    createStaffBroadcast({
      organizationId: desk.organizationId,
      employeeId: desk.employeeId,
      templateId,
      fromPhoneNumberId: from,
    })
  );

  const recipients = await withTenant(desk.organizationId, () =>
    createBroadcastRecipients(
      broadcast.id,
      audience.map((person) => person.id)
    )
  );

  await withTenant(desk.organizationId, () => updateBroadcastStatus(broadcast.id, "sending"));

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
        // The stamped number, not the employee's current one. If those ever
        // disagree it is because somebody was reassigned mid-send, and the row
        // records what was committed to.
        phoneNumberId: from,
        templateName: template.metaTemplateName,
        templateLanguage: template.language,
        templateParams: staffTemplateParams(template.bodyParamCount, person.displayName),
      });
    })
  );

  logger.info(
    { employeeId: desk.employeeId, broadcastId: broadcast.id, recipients: recipients.length, from },
    "Staff campaign enqueued"
  );
  return c.json({
    broadcastId: broadcast.id,
    enqueued: recipients.length,
    // Present only when it matters. A warning that appears on every send is one
    // nobody reads by the third campaign.
    dailyCeiling: overDailyCeiling,
    healthWarning,
  });
});

// ============================================================
// Email campaigns (26 Oct 2026)
// ============================================================

const EMAIL_SUBJECT_MAX = 200;
const EMAIL_BODY_MAX = 10_000;

/** Subject and message as typed, or why not. Too long is refused, never cut short. */
export function emailContentRefusal(subject: unknown, body: unknown): string | null {
  if (typeof subject !== "string" || !subject.trim()) return "Write a subject.";
  if (typeof body !== "string" || !body.trim()) return "Write the message.";
  if (subject.trim().length > EMAIL_SUBJECT_MAX) return `Keep the subject under ${EMAIL_SUBJECT_MAX} characters.`;
  if (body.trim().length > EMAIL_BODY_MAX) return "Keep the message under 10,000 characters.";
  return null;
}

export const looksLikeAnEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

/** Send an email campaign to everybody in your book who can be emailed. */
myCampaignsRoute.post("/campaigns/email", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  const body = await c.req.json().catch(() => ({}));
  const refused = emailContentRefusal(body.subject, body.body);
  if (refused) return c.json({ error: refused }, 400);

  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  if (!employee) return c.json({ error: "Account not found." }, 404);
  if (!employee.canBroadcast) return c.json({ error: "Campaigns are not switched on for you." }, 403);

  const audience = await withTenant(desk.organizationId, () =>
    myClientsForEmailCampaign(desk.organizationId, desk.employeeId)
  );
  if (audience.length === 0) {
    return c.json({ error: "Nobody in your book can be emailed — no addresses, or everyone unsubscribed." }, 422);
  }
  const mailbox = await resolveCampaignMailbox(desk.organizationId, desk.employeeId);
  if ("error" in mailbox) return c.json({ error: mailbox.error }, 409);

  const queued = await queueEmailCampaign({
    organizationId: desk.organizationId,
    employeeId: desk.employeeId,
    subject: body.subject.trim(),
    body: body.body.trim(),
    audience,
    mailbox,
  });
  return c.json({ ...queued, enqueued: audience.length, from: mailbox.address });
});

/**
 * Try the email on yourself first. The same renderer and the same mailbox as
 * the campaign, to one address, and nothing written: no campaign row, no
 * recipient, nothing counted. The unsubscribe link in it goes nowhere real.
 */
myCampaignsRoute.post("/campaigns/email/test", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  const body = await c.req.json().catch(() => ({}));
  const refused = emailContentRefusal(body.subject, body.body);
  if (refused) return c.json({ error: refused }, 400);
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!looksLikeAnEmail(to)) return c.json({ error: "Which email address should the test go to?" }, 400);

  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  const organization = await withTenant(desk.organizationId, () => findOrganizationById(desk.organizationId));
  if (!employee || !organization) return c.json({ error: "Account not found." }, 404);
  if (!employee.canBroadcast) return c.json({ error: "Campaigns are not switched on for you." }, 403);
  const mailbox = await resolveCampaignMailbox(desk.organizationId, desk.employeeId);
  if ("error" in mailbox) return c.json({ error: mailbox.error }, 409);
  if (!takeTestSend(desk.employeeId)) {
    return c.json({ error: `That is ${TEST_SENDS_PER_HOUR} tests this hour — try again later.` }, 429);
  }

  const mail = renderCampaignEmail({
    subject: `[Test] ${body.subject.trim()}`,
    body: body.body.trim(),
    displayName: employee.fullName,
    unsubscribeUrl: unsubscribeUrl(apiBaseUrl(), "test"),
    businessName: organization.name,
    fromAddress: mailbox.address,
  });
  try {
    await sendFromMailbox(desk.organizationId, mailbox, { to, ...mail });
    return c.json({ ok: true, from: mailbox.address });
  } catch (err) {
    logger.warn({ employeeId: desk.employeeId, err }, "Email campaign test refused");
    return c.json({ error: explainEmailSendError(err) }, 502);
  }
});

/** The instruction for polishing a campaign email: {name} survives, nothing is added. */
export const CAMPAIGN_POLISH_PROMPT =
  "You fix spelling, grammar and clarity in a short marketing email a business is sending to its own customers. Keep the meaning, the tone, and every specific fact, name, price, date, link and number exactly as written. Keep {name} exactly as written wherever it appears — it is filled in later. Do not add offers, claims or information, and do not add a greeting or sign-off that is not there. Return ONLY the corrected text, with no preamble or quotation marks.";

/** Tidy the wording of a campaign email. */
myCampaignsRoute.post("/campaigns/polish", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  const body = await c.req.json<{ text?: unknown }>().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Nothing to polish." }, 400);
  if (text.length > 2000) return c.json({ error: "That is longer than the polisher takes at once." }, 413);
  const polished = await completeText({ system: CAMPAIGN_POLISH_PROMPT, prompt: text, maxTokens: 900 });
  if (!polished) return c.json({ error: "The polisher is not available right now." }, 503);
  return c.json({ text: polished });
});

/**
 * Resume or stop one of your own campaigns. Whose campaign is compared to the
 * person signed in, literally: another person's campaign id answers 404, the
 * same as an id that does not exist.
 */
async function controlOwnCampaign(c: Context, action: "resume" | "stop") {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  // Read straight from the session as well as through deskOf, so the check is
  // visible where the id arrives: a staff member, of this business, owning it.
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope || scope.role !== "employee" || scope.organizationId !== desk.organizationId) {
    return c.json({ error: "Campaign not found." }, 404);
  }
  const campaign = await withTenant(desk.organizationId, () => campaignForControl(c.req.param("id") ?? ""));
  if (!campaign || campaign.employeeId !== desk.employeeId || campaign.organizationId !== desk.organizationId) {
    return c.json({ error: "Campaign not found." }, 404);
  }
  const result = action === "resume" ? await resumeCampaign(campaign.id) : await stopCampaign(campaign.id);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
}

myCampaignsRoute.post("/campaigns/:id/resume", (c) => controlOwnCampaign(c, "resume"));
myCampaignsRoute.post("/campaigns/:id/stop", (c) => controlOwnCampaign(c, "stop"));

/**
 * Whether this template may go out from this sender — the checks a campaign and
 * a test send share, so a test that passes is a campaign that will be accepted.
 */
function templateRefusal(
  template: { isApproved: boolean; organizationId: string; whatsappBusinessAccountId: string | null; metaTemplateName: string },
  organization: { id: string; slug: string },
  sendingAccount: string | null,
  employeeId: string
): { error: string; status: 403 | 422 } | null {
  if (!template.isApproved) return { error: "WhatsApp has not approved that message.", status: 422 };
  if (!staffMayUseTemplate(template.metaTemplateName, employeeId)) {
    return { error: "That message belongs to a colleague.", status: 403 };
  }
  if (template.organizationId !== organization.id) {
    return { error: "That message belongs to a different business.", status: 403 };
  }
  if (template.whatsappBusinessAccountId !== sendingAccount) {
    return {
      error:
        "That message is approved on a different WhatsApp account from the number you send from, so WhatsApp would refuse it. Choose one of the messages listed for your number.",
      status: 422,
    };
  }
  if (attributeTemplate(template.metaTemplateName, organization.slug) === "other-business") {
    return { error: describeWrongTemplate(template.metaTemplateName, organization.slug), status: 422 };
  }
  return null;
}

/**
 * Why a test send to `to` is refused, or null. Exported for its test.
 *
 * Not the profile number: connecting a WhatsApp Business number overwrites
 * employees.whatsapp_number with that very number, and a number cannot message
 * itself — so the sender types the number to try it on.
 */
export function testSendRefusal(to: string, sendingDisplayNumber: string | null): string | null {
  const digits = internationalDigits(to);
  if (digits.length < 8 || /[a-z]/i.test(to)) return "That is not a phone number.";
  // Checked first, so typing your own number without the + gets the reason
  // that actually applies.
  if (sendingDisplayNumber && digits === internationalDigits(sendingDisplayNumber)) {
    return "That is the number the campaign sends from — use your personal WhatsApp.";
  }
  // INTERNATIONAL FORM ONLY (review, 22 Oct 2026). "525631476" is a UAE mobile
  // typed locally; sent as it stands it is +52, a stranger in Mexico.
  if (!/^\s*(\+|00)/.test(to)) {
    return "Write the number with its country code, starting with + (for example +971 50 123 4567).";
  }
  return null;
}

/** The number as WhatsApp wants it: digits only, an international 00 dropped. */
export function internationalDigits(input: string): string {
  return input.replace(/\D/g, "").replace(/^00/, "");
}

/**
 * At most TEST_SENDS_PER_HOUR tests per person per hour. Kept in this process:
 * one API container serves every request, and a restart forgetting the count
 * is harmless — the limit only stops a test send becoming an unmetered sender.
 */
const TEST_SENDS_PER_HOUR = 5;
const testSends = new Map<string, number[]>();
function takeTestSend(employeeId: string, now = Date.now()): boolean {
  const recent = (testSends.get(employeeId) ?? []).filter((at) => now - at < 3_600_000);
  if (recent.length >= TEST_SENDS_PER_HOUR) {
    testSends.set(employeeId, recent);
    return false;
  }
  recent.push(now);
  testSends.set(employeeId, recent);
  return true;
}

/**
 * Try a message on yourself before your whole book gets it.
 *
 * A staff campaign always goes to everybody in the book, so until this existed
 * the only way to learn whether a message arrives was to send it to all of
 * them. This goes through the SAME send and the SAME template checks, to one
 * number, and leaves nothing behind: no broadcast row, no recipient, nothing
 * counted against any limit. Meta's answer comes back in words.
 */
myCampaignsRoute.post("/campaigns/test", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const templateId = text(body.templateId, 64);
  const to = text(body.to, 40);
  if (!templateId) return c.json({ error: "Choose a message to try." }, 400);
  if (!to) return c.json({ error: "Which number should the test go to?" }, 400);

  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  const organization = await withTenant(desk.organizationId, () => findOrganizationById(desk.organizationId));
  if (!employee || !organization) return c.json({ error: "Account not found." }, 404);
  if (!employee.canBroadcast) return c.json({ error: "Campaigns are not switched on for you." }, 403);

  const sharedRetired = await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId);
  const from = employee.whatsappPhoneNumberId ?? (sharedRetired ? null : organization.whatsappPhoneNumberId);
  if (!from) {
    return c.json({ error: "You have no WhatsApp number to send from yet. Connect yours in Connections first." }, 409);
  }

  const refusedTo = testSendRefusal(to, employee.whatsappPhoneNumberId ? employee.whatsappNumber ?? null : null);
  if (refusedTo) return c.json({ error: refusedTo }, 400);
  const toDigits = internationalDigits(to);
  if (await isWaIdOptedOut(toDigits)) {
    return c.json({ error: "That number belongs to someone who asked not to be messaged." }, 400);
  }
  if (!takeTestSend(desk.employeeId)) {
    return c.json({ error: `That is ${TEST_SENDS_PER_HOUR} tests this hour — try again later.` }, 429);
  }

  const template = await withTenant(desk.organizationId, () => getBroadcastTemplate(templateId));
  if (!template) return c.json({ error: "That message no longer exists." }, 404);
  const refusal = templateRefusal(template, organization, sendingAccountOf(employee, organization), desk.employeeId);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  try {
    const messageId = await sendWhatsAppTemplate(
      from,
      toDigits,
      template.metaTemplateName,
      template.language,
      staffTemplateParams(template.bodyParamCount, employee.fullName)
    );
    logger.info({ employeeId: desk.employeeId, template: template.metaTemplateName, from, messageId }, "Campaign test sent");
    // Accepted is not delivered: noted so the receipt has somewhere to land
    // and the screen can say what WhatsApp actually did with it.
    if (messageId) {
      await noteTestSend(messageId, desk.employeeId).catch((err) =>
        logger.warn({ err, messageId }, "Could not note a campaign test for its receipt")
      );
    }
    return c.json({ ok: true, messageId });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const reason = explainSendError(raw);
    if (isPaymentRefusal(raw)) await notePaymentRefusal(from, raw).catch(() => undefined);
    logger.warn({ employeeId: desk.employeeId, template: template.metaTemplateName, from, reason }, "Campaign test refused");
    return c.json({ error: reason }, 502);
  }
});

/**
 * What WhatsApp did with a test, once it has said. "accepted" until a receipt
 * arrives; a failure carries Meta's reason in a sentence.
 */
myCampaignsRoute.get("/campaigns/test/:messageId", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  // Read straight from the session as well, as controlOwnCampaign does: a staff
  // member of this business, asking about their own test.
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope || scope.role !== "employee" || scope.organizationId !== desk.organizationId) {
    return c.json({ error: "No such test." }, 404);
  }
  const status = await readTestSend(c.req.param("messageId")).catch(() => null);
  // Somebody else's test reads as unknown, never as theirs.
  if (!status || status.employeeId !== desk.employeeId) return c.json({ error: "No such test." }, 404);
  return c.json({
    state: status.state,
    reason: status.reason ? explainSendError(status.reason) : null,
    at: status.at,
  });
});

// ============================================================
// A staff member's own messages (28 Oct 2026)
// ============================================================

/**
 * The WhatsApp account this person's messages are written to, with the token
 * that may write there: their own number's account when they have one (read
 * and written with that number's token, as the template sync does), the
 * business's otherwise.
 */
async function templateAccountFor(desk: { organizationId: string; employeeId: string }) {
  const employee = await withTenant(desk.organizationId, () => findEmployeeById(desk.employeeId));
  const organization = await withTenant(desk.organizationId, () => findOrganizationById(desk.organizationId));
  if (!employee || !organization) return { error: "Account not found.", status: 404 as const };
  if (!employee.canBroadcast) return { error: "Campaigns are not switched on for you.", status: 403 as const };
  const wabaId = sendingAccountOf(employee, organization);
  if (!wabaId) return { error: "There is no WhatsApp account to write messages to yet.", status: 409 as const };
  const own = Boolean(employee.whatsappPhoneNumberId) && wabaId !== organization.whatsappBusinessAccountId;
  let token = env.metaAccessToken;
  if (own) {
    const secret = await withTenant(desk.organizationId, () =>
      connectionSecret(desk.organizationId, desk.employeeId, "whatsapp")
    );
    if (!secret) {
      return {
        error: "Your WhatsApp connection has no stored key, so messages cannot be written to it. Reconnect it in Connections.",
        status: 409 as const,
      };
    }
    token = secret.accessToken;
  }
  return { employee, organization, wabaId, own, token };
}

/**
 * Write a message of your own and send it to WhatsApp for approval.
 *
 * MARKETING, always: a campaign to a client book is marketing whatever it says,
 * and a message submitted as utility is reclassified by Meta anyway. The opt-out
 * button is the same one the business's own marketing templates carry, for the
 * same reason — the number's quality rating is what a spam report spends.
 */
myCampaignsRoute.post("/templates", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const label = text(body.label, 60);
  if (!label) return c.json({ error: "Give the message a short name, like \"November offer\"." }, 400);
  const language = body.language === "ar" ? "ar" : "en";
  const content = staffTemplateBody(typeof body.text === "string" ? body.text : "");
  if ("error" in content) return c.json({ error: content.error }, 400);

  const account = await templateAccountFor(desk);
  if ("error" in account) return c.json({ error: account.error }, account.status);

  const name = staffTemplateName(desk.employeeId, label);
  const created = await createMetaTemplate(
    account.wabaId,
    {
      name,
      language,
      category: "MARKETING",
      body: content.body,
      example: content.example,
      buttons: [language === "ar" ? "إيقاف" : "Stop"],
    },
    account.token
  );
  if (!created.ok || !created.id) {
    const reason = created.error ?? "WhatsApp did not accept it.";
    logger.warn({ employeeId: desk.employeeId, name, reason }, "Staff template refused by Meta");
    return c.json(
      {
        error: /already exists|duplicate/i.test(reason)
          ? "You already have a message with that name in this language. Choose another name."
          : `WhatsApp did not accept it: ${reason}`,
      },
      422
    );
  }

  // Mirrored now rather than at the next half-hourly sync, so it is on the
  // screen as "waiting for WhatsApp" the moment it was sent.
  await withTenant(desk.organizationId, () =>
    upsertTemplateFromMeta({
      organizationId: desk.organizationId,
      whatsappBusinessAccountId: account.wabaId,
      metaTemplateId: created.id!,
      name,
      language,
      category: "MARKETING",
      status: created.status ?? "PENDING",
      bodyParamCount: content.paramCount,
    })
  );
  logger.info({ employeeId: desk.employeeId, name, status: created.status }, "Staff template submitted to Meta");
  return c.json({ ok: true, name, status: created.status ?? "PENDING" });
});

/** Ask WhatsApp again what it decided about this person's messages. */
myCampaignsRoute.post("/templates/refresh", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);
  const account = await templateAccountFor(desk);
  if ("error" in account) return c.json({ error: account.error }, account.status);
  try {
    if (account.own) {
      await syncStaffAccountTemplates({
        wabaId: account.wabaId,
        organizationId: desk.organizationId,
        organizationSlug: account.organization.slug,
        employeeId: desk.employeeId,
      });
    } else {
      await syncTemplatesForOrganization({
        id: account.organization.id,
        slug: account.organization.slug,
        whatsappBusinessAccountId: account.wabaId,
      });
    }
  } catch (err) {
    logger.warn({ employeeId: desk.employeeId, err }, "Staff template refresh failed");
    return c.json({ error: "WhatsApp could not be reached. Try again in a minute." }, 502);
  }
  return c.json({ ok: true });
});

/**
 * Fills a template's placeholders for one recipient.
 *
 * Meta rejects a send whose parameter count differs from the approved body, so
 * the count comes from the template rather than from how much happens to be
 * known about the person. An empty string counts as a MISSING parameter and
 * fails the whole send, which is why the filler is a character rather than "".
 */
export function staffTemplateParams(count: number, displayName: string | null): string[] {
  if (count <= 0) return [];
  const first = displayName?.trim() || "there";
  return [first, ...Array.from({ length: count - 1 }, () => "-")];
}

/**
 * Whether a campaign is larger than the number can still start today.
 *
 * Returns null when it comfortably fits, so the caller can treat presence as
 * the signal and nothing has to interpret a "false" that looks like a failure.
 *
 * The tier is read from Meta and the usage is counted from our own queued
 * recipients, which makes the used figure a FLOOR — a re-engagement message or
 * a template sent outside a campaign is not counted. Said as "at least" wherever
 * it is shown, because a precise-looking number that is quietly low is worse
 * than an honest approximation.
 */
export async function describeDailyCeiling(
  audienceSize: number,
  fromPhoneNumberId: string | null
): Promise<{ tier: string | null; limit: number; usedToday: number; remainingToday: number } | null> {
  // The number the campaign goes out from, not the company account's first
  // number: a staff member's own number has its own tier (22 Oct 2026).
  if (!fromPhoneNumberId) return null;
  try {
    const standing = await readNumberStanding(fromPhoneNumberId);
    const limit = standing?.dailyLimit ?? null;
    if (limit === null) return null;

    const usedToday = await dailyReachUsed(fromPhoneNumberId);
    const remainingToday = Math.max(0, limit - usedToday);
    if (audienceSize <= remainingToday) return null;

    return { tier: standing?.tier ?? null, limit, usedToday, remainingToday };
  } catch {
    return null;
  }
}
