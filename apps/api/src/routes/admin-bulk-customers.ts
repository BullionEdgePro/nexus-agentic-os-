import { Hono } from "hono";
import { assignContactOwnerIfUnowned, ensureContactForServingBusiness, isWaIdOptedOut } from "@nexus/db";
import { actorOf } from "../lib/actor.js";
import { logger } from "../lib/logger.js";
import { rowFailure } from "../lib/row-failure.js";
import { resolve } from "./admin-bulk.js";

/**
 * Adding client numbers straight into a campaign, for the admins (30 Oct 2026).
 *
 * The page reads the list — local numbers completed from the chosen country
 * and shown corrected — and sends only finished international numbers. They
 * go through the same door as the Customers import
 * (ensureContactForServingBusiness: one row per number, so adding the same
 * list twice adds nobody twice). The whole request is refused without the
 * consent tick, and anyone who asked any of our businesses not to be messaged
 * is refused by name. Every row answers for itself; nothing is dropped.
 *
 * Mounted under /api/bulk, behind operatorOnly like the rest of bulk messaging.
 */
export const adminBulkCustomersRoute = new Hono();

/**
 * Why a number is not the international form WhatsApp needs, or null when it is.
 *
 * Strict on purpose. Completing a local number is the page's job, where the
 * person sees "050 123 4567 → +971 50 123 4567"; here a "0501234567" can only
 * mean the page got it wrong, and storing it makes a customer nobody can reach.
 */
export function internationalWaIdRefusal(waId: string): string | null {
  if (!/^\d+$/.test(waId)) return "Send the number as digits only, in international form.";
  if (waId.length < 8 || waId.length > 15) return "That is not a full international number.";
  if (waId.startsWith("0")) return "That is a local number. Add the country code.";
  return null;
}

adminBulkCustomersRoute.post("/:slug/customers", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body?.consent !== true) {
    return c.json({ error: "Tick that these people agreed to get WhatsApp messages from this business." }, 400);
  }
  const rows: Array<{ waId?: unknown; displayName?: unknown; line?: unknown }> = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return c.json({ error: "There were no numbers to add." }, 400);
  // Bounded, as the Customers import is: a huge list would hold a connection
  // for minutes and time out having done an unknown share of the work.
  if (rows.length > 2000) return c.json({ error: "Add up to 2000 numbers at a time." }, 400);

  const resolved = await resolve(c, typeof body.phoneNumberId === "string" ? body.phoneNumberId : null);
  if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { organization, number } = resolved;
  if (!number) return c.json({ error: "Choose the number to send from." }, 400);

  const results: Array<{
    line: number | null;
    waId: string;
    outcome: "added" | "already-known" | "refused";
    reason?: string;
    contactId?: string;
  }> = [];

  // One at a time, as the Customers import does: rows share one upsert key,
  // and the same number twice in parallel would race on one row for no gain.
  for (const row of rows) {
    const waId = String(row?.waId ?? "").trim();
    const line = typeof row?.line === "number" ? row.line : null;
    const displayName =
      typeof row?.displayName === "string" && row.displayName.trim() ? row.displayName.trim().slice(0, 120) : null;
    const refusal = internationalWaIdRefusal(waId);
    if (refusal) {
      results.push({ line, waId, outcome: "refused", reason: refusal });
      continue;
    }
    try {
      if (await isWaIdOptedOut(waId)) {
        results.push({ line, waId, outcome: "refused", reason: "Asked not to be messaged." });
        continue;
      }
      const contact = await ensureContactForServingBusiness({
        servingOrganizationId: organization.id,
        waId,
        displayName,
      });
      let reason: string | undefined;
      // Into the book of the person whose number the campaign goes from, so
      // their replies reach that person. Someone in another book stays there.
      if (number.ownerEmployeeId) {
        const placed = await assignContactOwnerIfUnowned(contact.contactId, number.ownerEmployeeId);
        if (!placed.assigned && placed.currentOwnerName) reason = `already in ${placed.currentOwnerName}'s book`;
      }
      results.push({
        line,
        waId,
        outcome: contact.created ? "added" : "already-known",
        contactId: contact.contactId,
        ...(reason ? { reason } : {}),
      });
    } catch (err) {
      const failure = rowFailure(err);
      if (failure.stop) {
        logger.error({ organization: organization.slug, line, err }, "Adding numbers hit a database error; nothing was saved");
        return c.json(
          { error: `Nothing was added: the database refused the number on line ${line ?? "?"} (+${waId}). Try again in a minute.` },
          500
        );
      }
      results.push({ line, waId, outcome: "refused", reason: failure.reason });
    }
  }

  const added = results.filter((r) => r.outcome === "added").length;
  const alreadyKnown = results.filter((r) => r.outcome === "already-known").length;
  const refused = results.filter((r) => r.outcome === "refused").length;
  const actor = await actorOf(c);
  // WHO SAID THEY AGREED. Consent is confirmed per batch, not stored per
  // contact (that would need a migration); this line is the record of who
  // ticked it, for which business and number, and how many it covered.
  logger.info(
    { organization: organization.slug, from: number.phoneNumberId, by: actor.name, byId: actor.id, consent: true, added, alreadyKnown, refused },
    "Admin added numbers for bulk messaging"
  );
  return c.json({ results, added, alreadyKnown, refused });
});
