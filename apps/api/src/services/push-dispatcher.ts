import type { InboxSocketEvent } from "@nexus/shared";
import {
  getPushConversationFacts,
  listEmployees,
  listOwnerPushSubjects,
  listPushSubscriptionsForSubjects,
  recordPushOutcome,
  type PushSubscriptionRow,
} from "@nexus/db";
import { resolvePresence } from "@nexus/employees";
import { subscribeToInboxEvents } from "../lib/pubsub.js";
import { buildMessagePayload, buildPlatformPayload, pushConfigured, sendPush, type PushPayload } from "../lib/web-push.js";
import { computeJobsHealth } from "../lib/jobs-health.js";
import { getRedisConnection } from "../queue/queue.js";
import { logger } from "../lib/logger.js";
import { decideRecipients, type PushContext, type PushRecipients } from "./push-rules.js";

/**
 * Tells people's phones (spec 2026-10-09-nexus-mobile-app-design.md). Runs in
 * the worker.
 *
 * It ONLY LISTENS: it hears the same inbox events the web inbox hears and has
 * no way to send a customer anything — no WhatsApp client, no reply path, no
 * publisher. Who to tell is decided by decideRecipients; this gathers the facts
 * that function needs, picks the devices, and delivers.
 */
type Device = Pick<PushSubscriptionRow, "id" | "subject" | "mode" | "previews" | "endpoint" | "p256dh" | "auth">;

/**
 * The devices a decision reaches. A paused device is never woken; "all" reaches
 * only devices set to hear everything; "mine" reaches mine and all. A device
 * named by two decisions is told once.
 */
export function devicesFor<T extends Device>(subs: T[], recipients: PushRecipients[]): T[] {
  const chosen = new Map<string, T>();
  for (const r of recipients) {
    const subjects = new Set(r.subjects);
    for (const sub of subs) {
      if (!subjects.has(sub.subject) || sub.mode === "paused") continue;
      if (r.requiresMode === "all" && sub.mode !== "all") continue;
      chosen.set(sub.id, sub);
    }
  }
  return [...chosen.values()];
}

async function deliver(subs: PushSubscriptionRow[], payloadFor: (sub: PushSubscriptionRow) => PushPayload): Promise<void> {
  // One dead or slow device never holds up the rest: each send is its own
  // promise with its own 10 s timeout, and every outcome is recorded.
  await Promise.allSettled(
    subs.map(async (sub) => {
      const outcome = await sendPush(sub, payloadFor(sub));
      await recordPushOutcome(sub.id, outcome);
    })
  );
}

async function handleEvent(event: InboxSocketEvent): Promise<void> {
  const kind: PushContext["kind"] = event.type === "message" ? "message" : event.type === "assigned" ? "assigned" : "other";
  if (kind === "other") return;
  const direction = event.message?.direction ?? null;
  // What the team itself sent never buzzes a phone; skip the reads entirely.
  if (kind === "message" && direction !== "inbound") return;

  const facts = await getPushConversationFacts(event.conversationId);
  if (!facts) return;

  const now = new Date();
  const staff = (await listEmployees(facts.servingOrganizationId)).map((employee) => ({
    employeeId: employee.id,
    active: employee.isActive,
    onShift: resolvePresence(employee, now).status !== "offline",
  }));
  const ctx: PushContext = {
    direction,
    kind,
    assigneeEmployeeId: facts.assigneeEmployeeId,
    newAssigneeEmployeeId: kind === "assigned" ? event.employeeId ?? null : null,
    staff,
    ownerSubjects: await listOwnerPushSubjects(),
  };

  const recipients = decideRecipients(ctx);
  if (recipients.length === 0) return;
  const subs = devicesFor(
    await listPushSubscriptionsForSubjects([...new Set(recipients.flatMap((r) => r.subjects))]),
    recipients
  );
  if (subs.length === 0) return;

  const customer = event.contactName?.trim() || facts.contactName || "A customer";
  await deliver(subs, (sub) =>
    buildMessagePayload(
      {
        conversationId: event.conversationId,
        customer,
        business: facts.servingName,
        kind: kind === "assigned" ? "assigned" : "message",
        text: event.message?.body ?? null,
      },
      sub.previews
    )
  );
}

/** Every failing job or queue, as the sentence an owner reads on the lock screen. */
async function currentProblems(): Promise<string[]> {
  const health = await computeJobsHealth();
  return [
    ...health.jobs.filter((j) => j.lastRunFailed || j.stalled).map((j) => `Background job "${j.job}" ${j.stalled ? "has stalled" : "is failing"}`),
    ...health.queues.filter((q) => q.failing).map((q) => `Queue "${q.queue}" is failing`),
  ];
}

async function alertOwnersAboutPlatform(): Promise<void> {
  const problems = await currentProblems();
  if (problems.length === 0) return;
  const redis = getRedisConnection();
  for (const problem of problems) {
    const payload = buildPlatformPayload(problem);
    // Once per problem per 6 hours: the key is set only if it is not already,
    // and expires by itself. A problem still there after 6 hours is told again.
    const first = await redis.set(`push:platform:${payload.tag.slice("platform-".length)}`, "1", "EX", 21_600, "NX");
    if (first !== "OK") continue;
    const owners = await listOwnerPushSubjects();
    const subs = devicesFor(await listPushSubscriptionsForSubjects(owners), [
      { subjects: owners, requiresMode: "mine" },
    ]);
    await deliver(subs, () => payload);
  }
}

/** Start listening. Returns a stop function; without VAPID keys it does nothing and says so once. */
export function startPushDispatcher(): () => void {
  if (!pushConfigured()) {
    logger.warn("Phone notifications are off: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are not set");
    return () => undefined;
  }
  const unsubscribe = subscribeToInboxEvents((event) => {
    handleEvent(event).catch((err) =>
      logger.warn({ err, conversationId: event.conversationId, type: event.type }, "Push dispatch failed")
    );
  });
  const timer = setInterval(() => {
    alertOwnersAboutPlatform().catch((err) => logger.warn({ err }, "Platform push alert failed"));
  }, 5 * 60 * 1000);
  timer.unref();
  logger.info("Phone notifications on: listening to inbox events, checking platform health every 5 minutes");
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
