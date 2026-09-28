import {
  findApprovedTemplateByName,
  getAssignmentAlertContext,
  withAllTenants,
  withoutTenant,
} from "@nexus/db";
import { normalizeWhatsAppNumber } from "@nexus/employees";
import type { BusinessSlug } from "@nexus/shared";
import { publishInboxEvent } from "../lib/pubsub.js";
import { sendWhatsAppTemplate } from "../lib/whatsapp-client.js";
import { logger } from "../lib/logger.js";

/**
 * The Meta template the phone alert is sent with. Utility category, approved on
 * the WhatsApp account of the number the business speaks from. Suggested body:
 *
 *   Hi {{1}}, a new chat from {{2}} ({{3}}) has been assigned to you in Nexus.
 *   Open your inbox to reply.
 *
 * Until a template of this name is approved, the phone alert is skipped and the
 * in-app alert still goes.
 */
export const ASSIGNED_TEMPLATE_NAME = "nexus_chat_assigned";

/** At most one phone alert per person per this window — a burst of chats at
 * shift start must not become a burst of pings. The in-app alert is not
 * throttled: it is per chat, and costs nothing. */
const PHONE_ALERT_GAP_MS = 10 * 60 * 1000;
const lastPhoneAlertAt = new Map<string, number>();

/** Long enough for the caller's transaction to commit, short enough to feel live. */
const SETTLE_MS = 1500;

/**
 * TELL THE PERSON A CHAT IS NOW THEIRS.
 *
 * Until this, an assignment changed a column and nothing else: the chat sat in
 * the assignee's inbox until they happened to open it. Two alerts now:
 *
 *   1. In Nexus — an "assigned" event on the live inbox stream. Every signed-in
 *      screen of that person listens for it (assignment-alerts.tsx) and shows a
 *      pop-up, plus a desktop notification if they allowed those.
 *   2. On their phone — a WhatsApp message from the business number to their
 *      personal number, IF an approved `nexus_chat_assigned` template exists.
 *      Business-initiated WhatsApp messages have to be a Meta-approved
 *      template; without one there is nothing that could be sent, so nothing is.
 *
 * FIRE-AND-FORGET, OFF THE CALLER'S TRANSACTION. The auto-assign claim runs
 * inside the reply pipeline's transaction; a Meta call there would hold the
 * connection open on someone else's network. So the alert waits a moment,
 * leaves the caller's tenant context entirely (withoutTenant), and reads on a
 * connection of its own. It re-checks that the chat is still with this person —
 * a colleague may have taken it in that moment — and never throws: the
 * assignment stands whether or not anybody hears about it.
 */
export function alertAssignee(input: {
  conversationId: string;
  employeeId: string;
  assignedBy: string;
}): void {
  const timer = setTimeout(() => {
    void withoutTenant(() =>
      withAllTenants("assignment alert: tell the person a chat is now theirs", () => sendAlerts(input))
    ).catch((err) =>
      logger.warn({ err, conversationId: input.conversationId }, "Assignment alert failed — the assignment stands")
    );
  }, SETTLE_MS);
  timer.unref?.();
}

async function sendAlerts(input: { conversationId: string; employeeId: string; assignedBy: string }): Promise<void> {
  const context = await getAssignmentAlertContext(input.conversationId, input.employeeId);
  if (!context || !context.stillTheirs || !context.employeeActive) return;

  await publishInboxEvent({
    type: "assigned",
    organizationId: context.servingOrganizationId,
    organizationSlug: context.servingSlug as BusinessSlug,
    conversationId: input.conversationId,
    employeeId: input.employeeId,
    contactName: context.contactName,
    assignedBy: input.assignedBy,
  }).catch((err) => logger.warn({ err }, "Could not publish the in-app assignment alert"));

  const to = normalizeWhatsAppNumber(context.employeeWhatsApp);
  if (!to || !context.ownerPhoneNumberId) return;

  const last = lastPhoneAlertAt.get(input.employeeId) ?? 0;
  if (Date.now() - last < PHONE_ALERT_GAP_MS) return;

  const template = await findApprovedTemplateByName(context.ownerOrganizationId, ASSIGNED_TEMPLATE_NAME);
  if (!template) return;

  const firstName = context.employeeName.trim().split(/\s+/)[0] || context.employeeName;
  const params = [firstName, context.contactName, context.servingName].slice(0, template.bodyParamCount);
  lastPhoneAlertAt.set(input.employeeId, Date.now());
  await sendWhatsAppTemplate(context.ownerPhoneNumberId, to, template.name, template.language, params);
  logger.info({ conversationId: input.conversationId, employeeId: input.employeeId }, "Assignment alert sent to the assignee's phone");
}
