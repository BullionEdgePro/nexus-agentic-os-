import { Hono } from "hono";
import {
  listMyClients,
  addClient,
  claimClient,
  releaseClient,
  updateClientDetails,
  broadcastAllowanceRemaining,
  findEmployeeById,
  findOrganizationById,
  withTenant,
  referralsForEmployee,
  getDisplayNumbers,
} from "@nexus/db";
import { listWabaNumbers } from "../lib/whatsapp-client.js";
import { buildStaffDeepLink } from "@nexus/agents";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * A staff member's own desk: their clients, their channel, their allowance.
 *
 * ============================================================
 * NOTHING HERE TAKES AN EMPLOYEE ID FROM THE CALLER
 * ============================================================
 *
 * Every query below is keyed on the employee id in the SESSION. An endpoint
 * under /my that accepts an id is an endpoint for reading a colleague's client
 * book, and it would look exactly like this one in a diff.
 *
 * An operator has no employee record — they own the platform rather than work
 * in one of its businesses — so they have no desk here. That is not a gap: the
 * operator already sees every client through the business screens, and giving
 * them an empty book would only invite the question of whose it was.
 */
export const myDeskRoute = new Hono();

export type Desk = { organizationId: string; employeeId: string };

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

/**
 * The signed-in staff member, or the reason there isn't one.
 *
 * Returns 403 rather than 404 for an operator: the desk is not missing, it is
 * not theirs. And a "view as staff" preview has no employee id either — it
 * narrows the business, not the person — so it lands here too, which is why the
 * message names that case rather than saying something unhelpful about roles.
 */
export function deskOf(c: { get: (k: string) => unknown }): Desk | { error: string } {
  const scope = scopeOf(c);
  if (scope.role !== "employee" || !scope.employeeId || !scope.organizationId) {
    return {
      error:
        "This is a staff member's own desk. An owner — including one previewing a business — is not one of the staff, so there is no book here to show.",
    };
  }
  return { organizationId: scope.organizationId, employeeId: scope.employeeId };
}

/**
 * Digits only, as a customer would dial.
 *
 * The same rule the rota script applies, for the same reason: a number carrying
 * spaces or a leading + produces a wa.me link that opens WhatsApp on nothing,
 * and a template send that fails at Meta rather than here. Rejected at a
 * plausible length rather than silently cleaned, so a typo surfaces while the
 * person who made it is still looking at the form.
 */
function normaliseWaId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// ============================================================
// The client book
// ============================================================

myDeskRoute.get("/clients", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const clients = await withTenant(desk.organizationId, () =>
    listMyClients(desk.organizationId, desk.employeeId, {
      search: c.req.query("q") ?? undefined,
    })
  );
  return c.json({ clients });
});

myDeskRoute.post("/clients", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const waId = normaliseWaId(body.waId);
  if (!waId) {
    return c.json(
      { error: "That is not a WhatsApp number a customer could be reached on. Digits only, with the country code." },
      400
    );
  }
  const displayName = text(body.displayName, 120);
  if (!displayName) return c.json({ error: "Give them a name you will recognise later." }, 400);

  const result = await addClient({
    organizationId: desk.organizationId,
    employeeId: desk.employeeId,
    waId,
    displayName,
    company: text(body.company, 120),
    note: text(body.note, 1000),
  });

  if (result.ok) return c.json({ client: result.client }, 201);

  // Three refusals, three different next actions for the person reading. A
  // single "already exists" would leave all three looking like a mistake.
  const message =
    result.reason === "already-yours"
      ? "They are already in your book."
      : result.reason === "already-the-business"
        ? "This person has messaged the business before, so they are already in the shared list. Open them there and claim them if they are yours."
        : `${result.heldBy} already has them. Client books are not moved by typing a number — ask them.`;
  return c.json({ error: message, reason: result.reason }, 409);
});

myDeskRoute.post("/clients/:id/claim", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const claimed = await withTenant(desk.organizationId, () =>
    claimClient(desk.organizationId, desk.employeeId, c.req.param("id"))
  );
  if (!claimed) {
    return c.json(
      { error: "Not claimed. Either they are not in this business's list, or a colleague already has them." },
      409
    );
  }
  logger.info(
    { employeeId: desk.employeeId, contactId: c.req.param("id") },
    "Contact claimed from the shared pool into a staff client book"
  );
  return c.json({ ok: true });
});

myDeskRoute.post("/clients/:id/release", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const released = await withTenant(desk.organizationId, () =>
    releaseClient(desk.organizationId, desk.employeeId, c.req.param("id"))
  );
  if (!released) return c.json({ error: "That is not one of your clients." }, 409);
  return c.json({ ok: true });
});

myDeskRoute.patch("/clients/:id", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const body = await c.req.json().catch(() => ({}));
  const client = await withTenant(desk.organizationId, () =>
    updateClientDetails(desk.organizationId, desk.employeeId, c.req.param("id"), {
      displayName: text(body.displayName, 120) ?? undefined,
      company: text(body.company, 120),
      note: text(body.note, 1000),
    })
  );
  if (!client) return c.json({ error: "That is not one of your clients." }, 404);
  return c.json({ client });
});

// ============================================================
// The channel
// ============================================================

/**
 * What number this person's messages actually go out from.
 *
 * ============================================================
 * SAYING THE TRUE THING RATHER THAN THE FLATTERING ONE
 * ============================================================
 *
 * The request behind this feature was "connect my own WhatsApp". For a personal
 * WhatsApp account that is not possible at any price — the consumer app has no
 * API, and the libraries that pretend otherwise drive a logged-in web session
 * in breach of WhatsApp's terms, with the ban landing on the business.
 *
 * What IS possible is a number registered on the company's WhatsApp Business
 * Account. So this endpoint answers with what Meta actually holds, and when a
 * staff member has no number of their own it says plainly that their messages
 * leave from the shared company number — rather than showing a blank that reads
 * as a private channel nobody has set up yet.
 */
myDeskRoute.get("/channel", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const [employee, organization] = await withTenant(desk.organizationId, async () => [
    await findEmployeeById(desk.employeeId),
    await findOrganizationById(desk.organizationId),
  ]);
  if (!employee || !organization) return c.json({ error: "Account not found." }, 404);

  const own = employee.whatsappPhoneNumberId;
  const allowance = await broadcastAllowanceRemaining(
    desk.employeeId,
    employee.broadcastMonthlyCap ?? 0
  );

  // Asked of Meta, not of our own table. A row saying "connected" is a claim;
  // the WABA listing is the fact, and the two disagree the moment somebody
  // removes a number at Meta without telling anybody here.
  let live: Awaited<ReturnType<typeof listWabaNumbers>> = [];
  let lookupFailed: string | null = null;
  try {
    live = await listWabaNumbers(organization.whatsappBusinessAccountId);
  } catch (err) {
    lookupFailed = err instanceof Error ? err.message : String(err);
    logger.warn({ err, organizationId: desk.organizationId }, "Could not ask Meta which numbers exist");
  }

  const mine = own ? live.find((number) => number.phoneNumberId === own) : undefined;
  const shared = live.find((number) => number.phoneNumberId === organization.whatsappPhoneNumberId);

  return c.json({
    // The three states are distinct on purpose. "own-number" and "shared" both
    // send; only the first is a private channel, and conflating them is the
    // whole thing this endpoint exists to avoid.
    state: mine ? "own-number" : own ? "claimed-but-not-on-the-account" : "shared",
    ownNumber: mine
      ? {
          phoneNumberId: mine.phoneNumberId,
          displayNumber: mine.displayPhoneNumber,
          verifiedName: mine.verifiedName,
          quality: mine.qualityRating,
        }
      : null,
    sharedNumber: shared
      ? { displayNumber: shared.displayPhoneNumber, verifiedName: shared.verifiedName, quality: shared.qualityRating }
      : null,
    personalNumberOnFile: employee.whatsappNumber ?? null,
    canBroadcast: employee.canBroadcast ?? false,
    allowance,
    lookupFailed,
  });
});

/**
 * Which numbers are available to be claimed.
 *
 * Only ever numbers Meta already holds on this account. There is no endpoint
 * for typing in a number and having the platform believe it, because that is
 * the version that fails at send time in front of a customer.
 */
myDeskRoute.get("/channel/available", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const organization = await withTenant(desk.organizationId, () =>
    findOrganizationById(desk.organizationId)
  );
  if (!organization) return c.json({ error: "Business not found." }, 404);

  try {
    const numbers = await listWabaNumbers(organization.whatsappBusinessAccountId);
    return c.json({
      numbers: numbers.map((number) => ({
        phoneNumberId: number.phoneNumberId,
        displayNumber: number.displayPhoneNumber,
        verifiedName: number.verifiedName,
        quality: number.qualityRating,
        isShared: number.phoneNumberId === organization.whatsappPhoneNumberId,
      })),
    });
  } catch (err) {
    logger.warn({ err }, "Could not list WABA numbers");
    return c.json(
      { error: "Could not ask WhatsApp which numbers exist right now. Nothing has changed — try again shortly." },
      502
    );
  }
});

/**
 * The link this person publishes on their own socials.
 *
 * ============================================================
 * WHY IT POINTS AT THE COMPANY NUMBER
 * ============================================================
 *
 * A staff member could paste their own wa.me link into an Instagram bio today
 * without any of this. What that gives them is a lead nobody else can see: no
 * record, no answer while they sleep, nothing to hand over when they leave, and
 * no way for the business to know the post worked.
 *
 * This link goes to the company number carrying a tag that names them. The
 * agent answers the inquiry — which is what that number is for — the lead is
 * theirs from the first word, and when the customer wants a person they get a
 * one-tap link to this staff member's own WhatsApp. The handover is a link the
 * CUSTOMER taps, which is why it needs no API and works today.
 */
myDeskRoute.get("/link", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const [employee, organization] = await withTenant(desk.organizationId, async () => [
    await findEmployeeById(desk.employeeId),
    await findOrganizationById(desk.organizationId),
  ]);
  if (!employee || !organization) return c.json({ error: "Account not found." }, 404);

  // The DIALABLE number, never whatsapp_phone_number_id. That is Meta's
  // internal id, and a wa.me link built from it looks correct, gets published
  // on a website, and fails for every customer who taps it.
  const numbers = await getDisplayNumbers();
  const companyNumber = numbers.get(organization.id) ?? null;

  const performance = await referralsForEmployee(desk.employeeId);

  return c.json({
    url: companyNumber
      ? buildStaffDeepLink({
          businessSlug: organization.slug,
          businessName: organization.name,
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          companyNumber,
        })
      : null,
    unavailableReason: companyNumber
      ? null
      : "This business has no WhatsApp number a customer could message yet.",
    // Whether a handover is even possible. Shown rather than assumed: a link
    // that brings leads to somebody the customer can never be passed to is
    // half a feature, and the person needs to know which half they have.
    handoverPossible: Boolean(employee.whatsappNumber),
    personalNumber: employee.whatsappNumber ?? null,
    performance,
  });
});
