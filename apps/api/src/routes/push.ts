import { Hono } from "hono";
import {
  deletePushSubscription,
  listPushSubscriptionsForSubject,
  recordPushOutcome,
  updatePushPreferences,
  upsertPushSubscription,
  type PushMode,
  type PushSubscriptionRow,
} from "@nexus/db";
import { readerOf } from "../lib/actor.js";
import type { SessionScope } from "../lib/session.js";
import { pushConfigured, sendPush } from "../lib/web-push.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * A person's phones, for push alerts (phone push, 4 Nov 2026; mobile plan Task 10).
 *
 * The dispatcher already decided who to tell and the service worker could show
 * an alert, but nothing ever registered a device, so every alert went to nobody.
 * Every handler works on the SIGNED-IN person's devices, found by readerOf: no
 * subject, employee or admin id is ever read from the body, and a device that is
 * not theirs answers 404 exactly like one that does not exist.
 */
export const pushRoute = new Hono();

const NOT_ENABLED = "Notifications aren't enabled on this server yet.";
const MODES: PushMode[] = ["mine", "all", "paused"];

/** What the page needs about a device -- never its push address or keys. */
function view(device: PushSubscriptionRow) {
  return {
    id: device.id,
    subject: device.subject,
    organizationId: device.organizationId,
    label: device.label,
    previews: device.previews,
    mode: device.mode,
    lastSuccessAt: device.lastSuccessAt,
    failureCount: device.failureCount,
  };
}

/** "iPhone", "Android" or "This computer", when the page names nothing. */
function labelFrom(userAgent: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iPhone";
  if (/Android/.test(userAgent)) return "Android";
  return "This computer";
}

/**
 * Being a device's person is the first half. For staff the device must also be
 * in the business they are signed in to -- defence in depth, the bookings and
 * tasks pattern -- so a phone filed under another business is not theirs from
 * this one. An admin's devices belong to no one business.
 */
function inReach(scope: SessionScope, device: PushSubscriptionRow): boolean {
  return scope.role !== "employee" || device.organizationId === scope.organizationId;
}

/** One of the person's own devices, or null: the same for "no such phone" and "not yours". */
async function ownDevice(scope: SessionScope, subject: string, id: string): Promise<PushSubscriptionRow | null> {
  const device = (await listPushSubscriptionsForSubject(subject)).find((d) => d.id === id);
  if (!device) return null;
  return scope.role !== "employee" || device.organizationId === scope.organizationId ? device : null;
}

pushRoute.get("/", async (c) => {
  const scope = c.get("scope") as SessionScope | undefined;
  const subject = readerOf(scope);
  if (!scope || !subject) return c.json({ error: "Unauthorized" }, 401);
  const configured = pushConfigured();
  const devices = (await listPushSubscriptionsForSubject(subject)).filter((d) => inReach(scope, d));
  return c.json({ configured, publicKey: configured ? env.vapidPublicKey : null, devices: devices.map(view) });
});

pushRoute.post("/", async (c) => {
  const scope = c.get("scope") as SessionScope | undefined;
  const subject = readerOf(scope);
  if (!subject) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    label?: unknown;
  } | null;
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh.trim() : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth.trim() : "";
  if (!/^https:\/\/\S+$/.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 200) {
    return c.json({ error: "This phone's notification details were incomplete. Try turning alerts on again." }, 400);
  }
  const userAgent = (c.req.header("user-agent") ?? "").slice(0, 300);
  const named = typeof body?.label === "string" ? body.label.trim().slice(0, 60) : "";
  const device = await upsertPushSubscription({
    subject,
    // A staff member's device belongs to their business; an admin's to no one business.
    organizationId: scope?.organizationId ?? null,
    endpoint,
    p256dh,
    auth,
    userAgent: userAgent || null,
    label: named || labelFrom(userAgent),
  });
  logger.info({ subject, deviceId: device.id, label: device.label }, "A phone was registered for alerts");
  return c.json({ device: view(device) });
});

pushRoute.patch("/:id", async (c) => {
  const scope = c.get("scope") as SessionScope | undefined;
  const subject = readerOf(scope);
  if (!scope || !subject) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as { previews?: unknown; mode?: unknown } | null;
  if (body?.previews !== undefined && typeof body.previews !== "boolean") return c.json({ error: "previews must be true or false" }, 400);
  if (body?.mode !== undefined && !MODES.includes(body.mode as PushMode)) return c.json({ error: "That is not one of the choices." }, 400);
  // "Every new chat nobody has taken" is the admins': under the own-book rule a
  // staff member cannot open an unassigned chat, so cannot ask to hear them.
  if (body?.mode === "all" && scope?.role === "employee") {
    return c.json({ error: "That choice is for admins. Staff are told about their own chats." }, 400);
  }
  if (!(await ownDevice(scope, subject, c.req.param("id")))) return c.json({ error: "That phone is not one of yours." }, 404);
  const device = await updatePushPreferences(c.req.param("id"), subject, {
    previews: body?.previews as boolean | undefined,
    mode: body?.mode as PushMode | undefined,
  });
  if (!device) return c.json({ error: "That phone is not one of yours." }, 404);
  return c.json({ device: view(device) });
});

pushRoute.delete("/:id", async (c) => {
  const scope = c.get("scope") as SessionScope | undefined;
  const subject = readerOf(scope);
  if (!scope || !subject) return c.json({ error: "Unauthorized" }, 401);
  if (!(await ownDevice(scope, subject, c.req.param("id")))) return c.json({ error: "That phone is not one of yours." }, 404);
  const removed = await deletePushSubscription(c.req.param("id"), subject);
  if (!removed) return c.json({ error: "That phone is not one of yours." }, 404);
  return c.json({ ok: true });
});

/** One alert to one of the person's own devices, so they can see it arrive. */
pushRoute.post("/:id/test", async (c) => {
  const scope = c.get("scope") as SessionScope | undefined;
  const subject = readerOf(scope);
  if (!scope || !subject) return c.json({ error: "Unauthorized" }, 401);
  const device = await ownDevice(scope, subject, c.req.param("id"));
  if (!device) return c.json({ error: "That phone is not one of yours." }, 404);
  if (!pushConfigured()) return c.json({ error: NOT_ENABLED }, 503);
  const outcome = await sendPush(device, {
    title: "Nexus",
    body: "Alerts are working on this phone.",
    tag: "nexus-test",
    // A page every role has: an admin has no My settings.
    url: "/deck/notifications",
  });
  await recordPushOutcome(device.id, outcome).catch((err) =>
    logger.warn({ err, deviceId: device.id }, "Could not record a test alert's outcome")
  );
  return c.json({ outcome });
});
