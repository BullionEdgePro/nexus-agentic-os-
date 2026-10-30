import { assignEmployeeWhatsAppNumber, saveConnection, withTenant } from "@nexus/db";
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
