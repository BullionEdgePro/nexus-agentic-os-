import {
  assignEmployeeWhatsAppNumber,
  saveConnection,
  withTenant,
  findOrganizationByPhoneNumberId,
  isWhatsAppNumberRetired,
} from "@nexus/db";
import { requestChatHistory } from "../lib/whatsapp-history.js";
import { getMainBusiness, wrongBusinessWarning } from "../lib/main-business.js";
import { readSendingHealth } from "../lib/whatsapp-client.js";
import {
  discoverWabaAndNumber,
  exchangeEmbeddedSignupCode,
  fetchCoexistenceNumber,
  subscribeAppToWaba,
} from "../lib/whatsapp-onboarding.js";
import { logger } from "../lib/logger.js";

const SHARED_LINE =
  "That is the shared company number — assigning it would send every customer to one person.";

/**
 * Why this number may not become one person's line, or null when it may.
 *
 * A business's own shared line, still live, carries every customer of every
 * business on it; giving it to one person would route them all to that person.
 * The Team screen has always refused that. A shared line that was switched off
 * (migration 094 — +971 50 480 5436 on 6 Oct) carries nobody any more, so a
 * person — an admin, through their seat — may connect it as their own.
 */
export async function sharedLineRefusal(phoneNumberId: string): Promise<string | null> {
  const business = await findOrganizationByPhoneNumberId(phoneNumberId);
  if (!business) return null;
  return (await isWhatsAppNumberRetired(phoneNumberId)) ? null : SHARED_LINE;
}

/**
 * Finish a WhatsApp Business app number's Embedded Signup for one staff member.
 *
 * One function for both doors (30 Oct 2026): a staff member connecting their
 * own number from Connections, and the owner connecting it for them from Team.
 * Whoever ran Meta's window, the number is filed under `employeeId`, so the two
 * ways cannot drift apart.
 *
 * The code exchange and the number link must succeed or nothing is stored;
 * reading the number's display form may fail — a connection that works with an
 * unknown label beats refusing one over a cosmetic lookup.
 */
export async function connectWhatsAppNumber(
  owner: { organizationId: string; employeeId: string },
  input: { code: string; wabaId?: string; phoneNumberId?: string }
): Promise<
  | { ok: true; number: string; history: Awaited<ReturnType<typeof requestChatHistory>>["state"]; businessWarning: string | null }
  | { error: string }
> {
  const { employeeId } = owner;
  let { wabaId, phoneNumberId } = input;
  try {
    const businessToken = await exchangeEmbeddedSignupCode(input.code);
    if (!wabaId || !phoneNumberId) {
      const found = await discoverWabaAndNumber(businessToken);
      wabaId = wabaId || found.wabaId;
      phoneNumberId = phoneNumberId || found.phoneNumberId;
    }
    // discoverWabaAndNumber throws when it finds nothing, so both are set by here;
    // this satisfies the type-checker and guards against an empty string slipping
    // through from the request body.
    if (!wabaId || !phoneNumberId) {
      return { error: "That WhatsApp sign-in did not return a usable number." };
    }
    // Bind to consts: narrowing of the `let`s above does not survive into the
    // withTenant closure below, where TS must still see them as plain strings.
    const connectedWabaId = wabaId;
    const connectedPhoneNumberId = phoneNumberId;
    // Before Meta is told or anything stored: a business's LIVE shared line is
    // never one person's (the Team screen's rule, now on both doors).
    const shared = await sharedLineRefusal(connectedPhoneNumberId);
    if (shared) return { error: shared };
    await subscribeAppToWaba(connectedWabaId, businessToken);
    const details = await fetchCoexistenceNumber(connectedPhoneNumberId, businessToken);

    await withTenant(owner.organizationId, async () => {
      // The credential, encrypted at rest like every other connection. external_id
      // is the phone_number_id — the thing the webhook router matches an inbound
      // message on — so a connection can always be traced back to the number.
      await saveConnection({
        organizationId: owner.organizationId,
        employeeId,
        provider: "whatsapp",
        externalId: connectedPhoneNumberId,
        displayName: details.displayNumber ?? details.verifiedName ?? connectedPhoneNumberId,
        avatarUrl: null,
        accessToken: businessToken,
        refreshToken: null,
        // System-user tokens from this exchange are long-lived; there is no
        // refresh dance, so no expiry is recorded rather than a guessed one.
        expiresAt: null,
        scopes: [],
      });

      // THE LINE THAT MAKES INBOUND ARRIVE ON THEIR DESK. It sets
      // whatsapp_phone_number_id on the employee, which is what
      // findEmployeeByPhoneNumberId reads in the queue processor to route a
      // message on this number to this person (handleStaffNumberMessage). A
      // number belongs to one person, and assigning frees it from anyone else.
      await assignEmployeeWhatsAppNumber(employeeId, {
        phoneNumberId: connectedPhoneNumberId,
        displayNumber: details.displayNumber,
        verifiedName: details.verifiedName,
        // Its templates are the ones it can send (migration 096).
        wabaId: connectedWabaId,
      });
    });

    logger.info(
      { employeeId, phoneNumberId: connectedPhoneNumberId, wabaId: connectedWabaId },
      "WhatsApp Business number connected via coexistence"
    );

    // THEIR PAST CHATS (28 Oct 2026). Meta sends the app's history only if asked,
    // within 24 hours and once — so it is asked here, the moment the number is
    // theirs, and imported as it arrives (lib/whatsapp-history.ts).
    const history = await requestChatHistory(connectedPhoneNumberId, businessToken);

    // WHICH CARD WILL PAY (30 Oct 2026). Meta asks which business to put the
    // number in, and a number outside the owner's main one cannot use the
    // company card — said now, while undoing it is one reconnect.
    const main = await getMainBusiness();
    const health = main ? await readSendingHealth(connectedPhoneNumberId) : null;
    const businessWarning = main ? wrongBusinessWarning(main, health?.businessId ?? null) : null;
    if (businessWarning) {
      logger.warn(
        { employeeId, phoneNumberId: connectedPhoneNumberId, businessId: health?.businessId, main: main?.id },
        "A staff number was connected outside the main business"
      );
    }

    return {
      ok: true,
      number: details.displayNumber ?? details.verifiedName ?? "connected",
      history: history.state,
      businessWarning,
    };
  } catch (err) {
    logger.error({ err, employeeId }, "WhatsApp coexistence connection failed");
    return { error: err instanceof Error ? err.message.slice(0, 200) : "unknown error" };
  }
}
