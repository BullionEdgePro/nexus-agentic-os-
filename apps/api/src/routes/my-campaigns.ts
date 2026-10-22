import { Hono } from "hono";
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
} from "@nexus/db";
import { attributeTemplate, describeWrongTemplate, isHiddenTemplate } from "@nexus/shared";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { listWabaNumbers, readNumberStanding, sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { deskOf, text } from "./my-desk.js";
import { campaignReadiness, sendingAccountOf } from "../services/campaign-readiness.js";
import { logger } from "../lib/logger.js";
import { explainSendError } from "../lib/send-errors.js";

/**
 * A staff member's own number, and campaigns to their own book.
 *
 * Split from my-desk.ts, which holds the client book itself. Same prefix, same
 * `deskOf` boundary: every handler resolves the person from the SESSION, and
 * nothing here accepts an employee id from the caller.
 */
export const myCampaignsRoute = new Hono();

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

  return c.json({
    campaigns,
    readiness,
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
    audience: audience.map((person) => ({ displayName: person.displayName, waId: person.waId })),
    // Approved, and speaking for THIS business. The same attribution check the
    // business broadcast route makes: on a shared WhatsApp account every
    // business holds a copy of every template, and Meta approving one says what
    // it may send, never who it is for.
    templates: templates
      .filter((template) => template.isApproved)
      .filter((template) => !isHiddenTemplate(template.metaTemplateName))
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
  });
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
  const refusal = templateRefusal(template, organization, sendingAccountOf(employee, organization));
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  const audience = await withTenant(desk.organizationId, () =>
    myClientsForBroadcast(desk.organizationId, desk.employeeId)
  );
  if (audience.length === 0) {
    return c.json(
      {
        error:
          "Nobody to send to. Either your book is empty, or everyone in it has asked not to be messaged.",
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

/**
 * Whether this template may go out from this sender — the checks a campaign and
 * a test send share, so a test that passes is a campaign that will be accepted.
 */
function templateRefusal(
  template: { isApproved: boolean; organizationId: string; whatsappBusinessAccountId: string | null; metaTemplateName: string },
  organization: { id: string; slug: string },
  sendingAccount: string | null
): { error: string; status: 403 | 422 } | null {
  if (!template.isApproved) return { error: "WhatsApp has not approved that message.", status: 422 };
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
  const digits = to.replace(/\D/g, "");
  if (digits.length < 8 || /[a-z]/i.test(to)) return "That is not a phone number.";
  if (sendingDisplayNumber && digits === sendingDisplayNumber.replace(/\D/g, "")) {
    return "That is the number the campaign sends from — use your personal WhatsApp.";
  }
  return null;
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

  const template = await withTenant(desk.organizationId, () => getBroadcastTemplate(templateId));
  if (!template) return c.json({ error: "That message no longer exists." }, 404);
  const refusal = templateRefusal(template, organization, sendingAccountOf(employee, organization));
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  try {
    const messageId = await sendWhatsAppTemplate(
      from,
      to.replace(/\D/g, ""),
      template.metaTemplateName,
      template.language,
      staffTemplateParams(template.bodyParamCount, employee.fullName)
    );
    logger.info({ employeeId: desk.employeeId, template: template.metaTemplateName, from }, "Campaign test sent");
    return c.json({ ok: true, messageId });
  } catch (err) {
    const reason = explainSendError(err instanceof Error ? err.message : String(err));
    logger.warn({ employeeId: desk.employeeId, template: template.metaTemplateName, from, reason }, "Campaign test refused");
    return c.json({ error: reason }, 502);
  }
});

/**
 * Fills a template's placeholders for one recipient.
 *
 * Meta rejects a send whose parameter count differs from the approved body, so
 * the count comes from the template rather than from how much happens to be
 * known about the person. An empty string counts as a MISSING parameter and
 * fails the whole send, which is why the filler is a character rather than "".
 */
function staffTemplateParams(count: number, displayName: string | null): string[] {
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
async function describeDailyCeiling(
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
