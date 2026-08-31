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
  listOrganizations,
  getBroadcastTemplate,
  createBroadcastRecipients,
  updateBroadcastStatus,
} from "@nexus/db";
import { attributeTemplate, describeWrongTemplate, isHiddenTemplate } from "@nexus/shared";
import { getBroadcastSendQueue } from "../queue/broadcast-queue.js";
import { listWabaNumbers, readAccountStanding } from "../lib/whatsapp-client.js";
import { deskOf, text } from "./my-desk.js";
import { logger } from "../lib/logger.js";

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

  const campaigns = await withTenant(desk.organizationId, () => listMyBroadcasts(desk.employeeId));
  const audience = await withTenant(desk.organizationId, () =>
    myClientsForBroadcast(desk.organizationId, desk.employeeId)
  );
  const templates = await withTenant(desk.organizationId, () =>
    listBroadcastTemplates(desk.organizationId)
  );
  const allowance = await broadcastAllowanceRemaining(
    desk.employeeId,
    employee.broadcastMonthlyCap ?? null
  );

  // What the NUMBER can still start today, shared across all six businesses.
  // Reported on the way in, not only after a send: a person deciding whether to
  // message four hundred people should see the ceiling while they decide.
  const ceiling = await describeDailyCeiling(audience.length);

  return c.json({
    campaigns,
    canBroadcast: employee.canBroadcast ?? false,
    allowance,
    dailyCeiling: ceiling,
    sendsFrom: employee.whatsappPhoneNumberId ? "your own number" : "the shared company number",
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

  const template = await withTenant(desk.organizationId, () => getBroadcastTemplate(templateId));
  if (!template) return c.json({ error: "That message no longer exists." }, 404);
  if (!template.isApproved) return c.json({ error: "WhatsApp has not approved that message." }, 422);
  if (template.organizationId !== organization.id) {
    return c.json({ error: "That message belongs to a different business." }, 403);
  }
  if (attributeTemplate(template.metaTemplateName, organization.slug) === "other-business") {
    return c.json(
      { error: describeWrongTemplate(template.metaTemplateName, organization.slug) },
      422
    );
  }

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
  const overDailyCeiling = await describeDailyCeiling(audience.length);
  if (overDailyCeiling) {
    logger.warn(
      { employeeId: desk.employeeId, audience: audience.length, ...overDailyCeiling },
      "Campaign is larger than the number can start today — sending anyway, per policy"
    );
  }

  // Their own number when they have one, the company's when they do not.
  // Stamped onto the row so the answer to "what did this go out from" never
  // changes afterwards.
  const from = employee.whatsappPhoneNumberId ?? organization.whatsappPhoneNumberId;

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
  });
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
  audienceSize: number
): Promise<{ tier: string | null; limit: number; usedToday: number; remainingToday: number } | null> {
  try {
    const organizations = await listOrganizations();
    const waba = organizations.find((o) => o.whatsappBusinessAccountId)?.whatsappBusinessAccountId;
    if (!waba) return null;

    const standing = await readAccountStanding(waba);
    const limit = standing?.dailyCustomerLimit ?? null;
    // No limit reported means an unlimited tier. Nothing to warn about.
    if (limit === null) return null;

    const usedToday = await dailyReachUsed();
    const remainingToday = Math.max(0, limit - usedToday);
    if (audienceSize <= remainingToday) return null;

    return { tier: standing?.tier ?? null, limit, usedToday, remainingToday };
  } catch {
    // Meta unreachable, or the count failed. The campaign is not blocked by our
    // inability to describe a ceiling — it was never being enforced here.
    return null;
  }
}
