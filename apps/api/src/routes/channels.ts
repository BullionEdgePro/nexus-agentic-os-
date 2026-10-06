import { Hono } from "hono";
import {
  findOrganizationBySlug,
  listBusinessMailboxes,
  removeConnection,
  saveConnection,
  whatsAppStanding,
  withAllTenants,
  withTenant,
} from "@nexus/db";
import { channelStatuses } from "../lib/channels.js";
import { verifyImapLogin } from "../lib/imap-email.js";
import { logger } from "../lib/logger.js";

/**
 * The Channels screen's data: where every messaging channel stands.
 *
 * Operator-only, mounted under /api/channels. It reads configuration, not tenant
 * data — the answer is the same for every business — so there is nothing to
 * scope, but it is still an owner's view: which channels the platform has
 * connected is a setup decision, not a sales executive's concern.
 */
export const channelsRoute = new Hono();

channelsRoute.get("/", async (c) => {
  return c.json({ channels: channelStatuses(await whatsAppStanding()) });
});

// ============================================================
// Business mailboxes — a mailbox for a whole business
// ============================================================

/**
 * The owner connects a mailbox FOR A BUSINESS (infojurisprimeuae@gmail.com for
 * Juris Prime, say), not for a staff member. Every email a person sends it
 * becomes a conversation in that business's inbox, Unassigned until someone
 * takes it; replies leave from the same mailbox.
 *
 * Address + password (for Gmail, a Google app password — it doesn't expire
 * weekly the way the Google sign-in does in testing mode). The password is
 * proven against the mail server before anything is stored, and sealed at rest
 * like every other credential; it is never returned or logged.
 */
channelsRoute.get("/mailboxes", async (c) => {
  const rows = await withAllTenants("owner's Channels screen lists every business mailbox", () =>
    listBusinessMailboxes()
  );
  return c.json({ mailboxes: rows });
});

channelsRoute.post("/mailboxes", async (c) => {
  const body = await c.req.json<{ business?: string; email?: string; password?: string }>().catch(() => null);
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password?.replace(/\s+/g, "");
  if (!body?.business || !email || !password) {
    return c.json({ error: "Choose a business, and enter the email address and its app password." }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "That does not look like an email address." }, 400);
  }
  const org = await findOrganizationBySlug(body.business);
  if (!org) return c.json({ error: "That business does not exist." }, 404);

  try {
    await verifyImapLogin(email, password);
  } catch (err) {
    logger.warn({ err, business: org.slug }, "Business mailbox sign-in failed");
    const gmail = /@(gmail|googlemail)\.com$/.test(email);
    return c.json(
      {
        error: gmail
          ? "Gmail refused that password. Use a Google app password (16 letters), not your normal password — and make sure 2-Step Verification is on for this account."
          : "That mailbox did not sign in. Check the password; some hosts need a dedicated app password.",
      },
      401
    );
  }

  await withTenant(org.id, () =>
    saveConnection({
      organizationId: org.id,
      employeeId: null,
      provider: "imap",
      externalId: email,
      displayName: email,
      avatarUrl: null,
      accessToken: password,
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    })
  );
  logger.info({ business: org.slug, email }, "Business mailbox connected");
  return c.json({ ok: true, business: org.slug, email });
});

channelsRoute.delete("/mailboxes/:business", async (c) => {
  const org = await findOrganizationBySlug(c.req.param("business"));
  if (!org) return c.json({ error: "That business does not exist." }, 404);
  const removed = await withTenant(org.id, () => removeConnection(org.id, null, "imap"));
  return c.json({ ok: removed });
});
