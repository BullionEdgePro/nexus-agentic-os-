import { Hono } from "hono";
import { connectionSecret, listBroadcastTemplates, upsertTemplateFromMeta, withTenant } from "@nexus/db";
import { bulkTemplateName, staffTemplateBody } from "@nexus/shared";
import { createMetaTemplate, readTemplateReviews } from "../lib/whatsapp-client.js";
import { syncStaffAccountTemplates, syncTemplatesForOrganization } from "../services/template-sync.js";
import { pendingFrom } from "../lib/pending-templates.js";
import { actorOf } from "../lib/actor.js";
import { logger } from "../lib/logger.js";
import { resolve, templatesFor, tokenFor, type SendingNumber } from "./admin-bulk.js";

/**
 * New approved messages, written by an admin in Bulk messaging (30 Oct 2026).
 *
 * Numbers added straight into a campaign have never written to the business,
 * so WhatsApp lets them get an approved message only; this is how the admin
 * gets new wording approved without leaving the page. The submission is the
 * one staff used (MARKETING, a Stop button, {name} as {{1}} with an example),
 * on the chosen number's own account, and the name carries the business
 * (`bulk_<code>_<label>`) so a sync never offers it to another business.
 *
 * Mounted under /api/bulk, behind operatorOnly like the rest of bulk messaging.
 */
export const adminBulkTemplatesRoute = new Hono();

const CANNOT_SUBMIT =
  "This number's WhatsApp connection cannot submit messages. Ask its owner to reconnect it in Connections.";
const META_DOWN = "WhatsApp could not be reached just now. Try Check again in a minute.";

/** Whether the number sits on its owner's own account (Coexistence), not the business's. */
function onOwnAccount(organization: { whatsappBusinessAccountId: string | null }, number: SendingNumber): boolean {
  return Boolean(number.ownerEmployeeId) && number.wabaId !== organization.whatsappBusinessAccountId;
}

/**
 * The token that may WRITE messages on the number's account. A staff number's
 * own account is reachable only with that number's stored token — the
 * platform's system user has no access there — so none stored means no.
 */
async function writeTokenFor(
  organization: { id: string; whatsappBusinessAccountId: string | null },
  number: SendingNumber
): Promise<string | null> {
  if (!onOwnAccount(organization, number)) return tokenFor(organization.id, number, organization.whatsappBusinessAccountId);
  const secret = await withTenant(organization.id, () =>
    connectionSecret(organization.id, number.ownerEmployeeId as string, "whatsapp")
  ).catch(() => null);
  return secret?.accessToken ?? null;
}

adminBulkTemplatesRoute.post("/:slug/number/:phoneNumberId/templates", async (c) => {
  const resolved = await resolve(c, c.req.param("phoneNumberId"));
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { organization, number } = resolved;
  if (!number?.wabaId) return c.json({ error: "Choose a number." }, 400);
  const wabaId = number.wabaId;

  const body = await c.req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  if (!label) return c.json({ error: "Give the message a short name, like \"Weekend viewings\"." }, 400);
  const language = body.language === "ar" ? "ar" : "en";
  const name = bulkTemplateName(organization.slug, label);
  if (!name) return c.json({ error: "New approved messages are not set up for this business." }, 422);
  const content = staffTemplateBody(typeof body.text === "string" ? body.text : "");
  if ("error" in content) return c.json({ error: content.error }, 400);

  const token = await writeTokenFor(organization, number);
  if (!token) return c.json({ error: CANNOT_SUBMIT }, 409);

  const created = await createMetaTemplate(
    wabaId,
    {
      name,
      language,
      category: "MARKETING",
      body: content.body,
      example: content.example,
      buttons: [language === "ar" ? "إيقاف" : "Stop"],
    },
    token
  ).catch(() => null);
  if (!created) return c.json({ error: META_DOWN }, 502);
  if (!created.ok || !created.id) {
    const reason = created.error ?? "WhatsApp did not accept it.";
    logger.warn({ organization: organization.slug, from: number.phoneNumberId, name, reason }, "WhatsApp refused an admin's new message");
    return c.json(
      {
        error: /already exists|duplicate/i.test(reason)
          ? "There is already a message with that name — choose another."
          : `WhatsApp did not accept it: ${reason}`,
      },
      422
    );
  }

  // Mirrored now rather than at the next half-hourly sync, so it shows as
  // "Waiting for WhatsApp" the moment it is sent.
  const metaTemplateId = created.id;
  await withTenant(organization.id, () =>
    upsertTemplateFromMeta({
      organizationId: organization.id,
      whatsappBusinessAccountId: wabaId,
      metaTemplateId,
      name,
      language,
      category: "MARKETING",
      status: created.status ?? "PENDING",
      bodyParamCount: content.paramCount,
    })
  );
  const actor = await actorOf(c);
  logger.info(
    { organization: organization.slug, from: number.phoneNumberId, name, status: created.status, by: actor.name },
    "Admin submitted a new approved message to WhatsApp"
  );
  return c.json({ name, status: created.status ?? "PENDING" });
});

/** Ask WhatsApp again about this number's messages: statuses, and reasons for any refused. */
adminBulkTemplatesRoute.post("/:slug/number/:phoneNumberId/templates/refresh", async (c) => {
  const resolved = await resolve(c, c.req.param("phoneNumberId"));
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { organization, number } = resolved;
  if (!number?.wabaId) return c.json({ error: "Choose a number." }, 400);
  const wabaId = number.wabaId;

  const token = await writeTokenFor(organization, number);
  if (!token) return c.json({ error: CANNOT_SUBMIT }, 409);
  try {
    if (onOwnAccount(organization, number)) {
      await syncStaffAccountTemplates({
        wabaId,
        organizationId: organization.id,
        organizationSlug: organization.slug,
        employeeId: number.ownerEmployeeId as string,
      });
    } else {
      await syncTemplatesForOrganization({ id: organization.id, slug: organization.slug, whatsappBusinessAccountId: wabaId });
    }
    const reviews = await readTemplateReviews(wabaId, token);
    const rows = await withTenant(organization.id, () => listBroadcastTemplates(organization.id, wabaId));
    return c.json({ pending: pendingFrom(rows, organization.slug, reviews), templates: await templatesFor(organization, wabaId) });
  } catch (err) {
    logger.warn({ organization: organization.slug, from: number.phoneNumberId, err }, "Checking approved messages with WhatsApp failed");
    return c.json({ error: META_DOWN }, 502);
  }
});
