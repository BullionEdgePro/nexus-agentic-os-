import {
  createEmailBroadcast,
  createEmailRecipients,
  emailSentFromMailbox24h,
  withTenant,
  type EmailAudienceMember,
} from "@nexus/db";
import { splitByDailyCap } from "../lib/campaign-email.js";
import { getEmailBroadcastQueue } from "../queue/email-broadcast-queue.js";
import type { CampaignMailbox } from "./campaign-mailbox.js";
import { logger } from "../lib/logger.js";

const DAY_MS = 86_400_000;

/** Emails one mailbox sends from campaigns in any rolling 24 hours. */
export function emailDailyCap(): number {
  const raw = Number(process.env.EMAIL_CAMPAIGN_DAILY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 300;
}

/**
 * How a campaign of `count` would go out from this mailbox: people per day,
 * today first. Read-only — shown before anybody presses send, so "300 today,
 * 120 tomorrow" is known in advance rather than discovered.
 */
export async function planEmailCampaign(count: number, mailboxAddress: string | null): Promise<number[]> {
  if (!mailboxAddress || count <= 0) return count > 0 ? [count] : [];
  return splitByDailyCap(count, await emailSentFromMailbox24h(mailboxAddress), emailDailyCap());
}

/**
 * Queue an email campaign: the row, one recipient per person with the address
 * frozen, and one delayed job each. Shared by the staff and the admin routes so
 * the two cannot pace or stamp differently.
 */
export async function queueEmailCampaign(input: {
  organizationId: string;
  employeeId: string | null;
  subject: string;
  body: string;
  audience: EmailAudienceMember[];
  mailbox: CampaignMailbox;
}): Promise<{ broadcastId: string; plan: number[] }> {
  const plan = await planEmailCampaign(input.audience.length, input.mailbox.address);

  // Day n's people wait n days. The order is the audience's own (by address),
  // so the spill is stable rather than random.
  const now = Date.now();
  const people: Array<{ contactId: string; toAddress: string; sendAfter: Date | null; day: number }> = [];
  let index = 0;
  plan.forEach((size, day) => {
    for (let k = 0; k < size; k++, index++) {
      const person = input.audience[index];
      people.push({
        contactId: person.id,
        toAddress: person.email,
        sendAfter: day === 0 ? null : new Date(now + day * DAY_MS),
        day,
      });
    }
  });

  const broadcast = await withTenant(input.organizationId, () =>
    createEmailBroadcast({
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      subject: input.subject,
      body: input.body,
      fromMailbox: input.mailbox.address,
      fromMailboxEmployeeId: input.mailbox.employeeId,
    })
  );
  const recipients = await withTenant(input.organizationId, () =>
    createEmailRecipients(
      broadcast.id,
      people.map(({ contactId, toAddress, sendAfter }) => ({ contactId, toAddress, sendAfter }))
    )
  );

  const dayOf = new Map(people.map((p) => [p.contactId, p.day]));
  const queue = getEmailBroadcastQueue();
  await queue.addBulk(
    recipients.map((recipient) => ({
      name: "send",
      data: { broadcastId: broadcast.id, recipientId: recipient.id },
      opts: { delay: (dayOf.get(recipient.contactId) ?? 0) * DAY_MS, jobId: `email-${recipient.id}` },
    }))
  );

  logger.info(
    { broadcastId: broadcast.id, employeeId: input.employeeId, recipients: recipients.length, plan, from: input.mailbox.address },
    "Email campaign queued"
  );
  return { broadcastId: broadcast.id, plan };
}
