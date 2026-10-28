import {
  findEmployeeById,
  findOrganizationById,
  isWhatsAppNumberRetired,
  listBroadcastTemplates,
  myClientsForBroadcast,
  withTenant,
} from "@nexus/db";
import { attributeTemplate, isHiddenTemplate, staffMayUseTemplate } from "@nexus/shared";
import { readSendingHealth, type SendingHealth } from "../lib/whatsapp-client.js";

/**
 * What stands between a staff member and a campaign.
 *
 * FOUND 22 OCT 2026. Ten staff were allowed to send; one could. The rest met a
 * disabled picker with no reason, and the four reasons have four different
 * fixes, only one of which is theirs. So each check carries its own `fix`, and
 * the send itself refuses on exactly these checks — the screen and the server
 * cannot disagree about whether somebody is ready.
 *
 * `ok: null` is "could not check", and is never treated as a pass.
 */
export interface ReadinessCheck {
  key: "allowed" | "number" | "account" | "message" | "clients";
  ok: boolean | null;
  detail: string;
  fix: string | null;
}

export interface ReadinessFacts {
  canBroadcast: boolean;
  ownNumber: boolean;
  /** Whether the business's shared number was switched off (6 Oct 2026). */
  numberRetired: boolean;
  /** Messages on the sending account this business may send, approved. */
  approved: number;
  /** The same, submitted and still waiting for WhatsApp's decision. */
  pending: number;
  clients: number;
  /**
   * What WhatsApp says about sending from the number (28 Oct 2026); null when
   * it did not answer. A blocked account — most often no payment method, the
   * 131042 that refused 30 of 30 — is refused here, before anything is queued.
   */
  health: SendingHealth | null;
}

/**
 * The account check. Meta not answering is NOT a refusal, unlike `ok: null`
 * elsewhere: the health call is one more round trip on the way into the screen,
 * and a hiccup in it must not stop every campaign on the platform. The send's
 * own receipt still reports a block afterwards, in words.
 */
function accountCheck(health: SendingHealth | null): ReadinessCheck {
  if (health?.problem) {
    return {
      key: "account",
      ok: false,
      detail: `WhatsApp is blocking messages from this number: ${health.problem.description}`,
      fix:
        health.problem.solution ??
        "Whoever owns this WhatsApp account fixes it in Meta Business Suite — for a payment problem, add a payment method at business.facebook.com/billing_hub.",
    };
  }
  return {
    key: "account",
    ok: true,
    detail: health ? "WhatsApp says this number can send." : "WhatsApp did not say whether this number can send just now.",
    fix: null,
  };
}

export function readinessFrom(facts: ReadinessFacts): ReadinessCheck[] {
  const hasNumber = facts.ownNumber || !facts.numberRetired;
  return [
    facts.canBroadcast
      ? { key: "allowed", ok: true, detail: "You may send campaigns.", fix: null }
      : {
          key: "allowed",
          ok: false,
          detail: "Campaigns are not switched on for you.",
          fix: "Ask the owner to turn on campaigns for you in Team.",
        },
    hasNumber
      ? {
          key: "number",
          ok: true,
          detail: facts.ownNumber ? "Sending from your own WhatsApp number." : "Sending from the shared company number.",
          fix: null,
        }
      : {
          key: "number",
          ok: false,
          detail: "You have no WhatsApp number of your own, and the shared company number is switched off.",
          fix: "Open Connections, then WhatsApp → Connect WhatsApp, and connect your WhatsApp Business number.",
        },
    // Only once there is a number to ask about.
    ...(hasNumber ? [accountCheck(facts.health)] : []),
    facts.approved > 0
      ? {
          key: "message",
          ok: true,
          detail: `${facts.approved} message${facts.approved === 1 ? "" : "s"} approved on your number.`,
          fix: null,
        }
      : facts.pending > 0
        ? {
            key: "message",
            ok: false,
            detail: `${facts.pending} message${facts.pending === 1 ? " is" : "s are"} waiting for WhatsApp to approve.`,
            fix: "Nothing to do — WhatsApp usually decides within a few hours, and this updates by itself.",
          }
        : {
            key: "message",
            ok: false,
            detail: "There is no message on your number yet.",
            fix: hasNumber
              ? "Nexus submits your business's messages to your number by itself within half an hour of connecting. If this stays empty, tell the owner."
              : "This follows once your number is connected.",
          },
    facts.clients > 0
      ? {
          key: "clients",
          ok: true,
          detail: `${facts.clients} client${facts.clients === 1 ? "" : "s"} with WhatsApp in your book.`,
          fix: null,
        }
      : {
          key: "clients",
          ok: false,
          detail: "Nobody in your book has a WhatsApp number (or everyone asked not to be messaged).",
          fix: "Clients who message your number join your book by themselves. The owner can also import a list into your book from Customers.",
        },
  ];
}

/**
 * The WhatsApp account a campaign goes out from: the staff member's own number's
 * account when they have one (a Coexistence number sits on its own portfolio's
 * account), else the business's. A number assigned from the business's own
 * account (Team, or claimed here) records none, so it falls back to the
 * business's, which is where it is.
 */
export function sendingAccountOf(
  employee: { whatsappPhoneNumberId?: string | null; whatsappBusinessAccountId?: string | null },
  organization: { whatsappBusinessAccountId: string | null }
): string | null {
  if (employee.whatsappPhoneNumberId) {
    return employee.whatsappBusinessAccountId ?? organization.whatsappBusinessAccountId;
  }
  return organization.whatsappBusinessAccountId;
}

/** The checks, read from the database for one staff member. */
export async function campaignReadiness(employeeId: string, organizationId: string): Promise<ReadinessCheck[]> {
  const [employee, organization] = await withTenant(organizationId, async () => [
    await findEmployeeById(employeeId),
    await findOrganizationById(organizationId),
  ] as const);
  if (!employee || !organization) {
    return readinessFrom({ canBroadcast: false, ownNumber: false, numberRetired: true, approved: 0, pending: 0, clients: 0, health: null });
  }

  const account = sendingAccountOf(employee, organization);
  const usable = (await withTenant(organizationId, () => listBroadcastTemplates(organizationId, account))).filter(
    (template) =>
      !isHiddenTemplate(template.metaTemplateName) &&
      staffMayUseTemplate(template.metaTemplateName, employeeId) &&
      attributeTemplate(template.metaTemplateName, organization.slug) !== "other-business"
  );
  const clients = await withTenant(organizationId, () => myClientsForBroadcast(organizationId, employeeId));
  const numberRetired = await isWhatsAppNumberRetired(organization.whatsappPhoneNumberId);
  // The number the campaign would go out from — the same choice the send makes.
  const sendingNumber = employee.whatsappPhoneNumberId ?? (numberRetired ? null : organization.whatsappPhoneNumberId);

  return readinessFrom({
    canBroadcast: employee.canBroadcast ?? false,
    ownNumber: Boolean(employee.whatsappPhoneNumberId),
    numberRetired,
    approved: usable.filter((template) => template.isApproved).length,
    pending: usable.filter((template) => !template.isApproved && /PENDING|IN_APPEAL/i.test(template.status ?? "")).length,
    clients: clients.length,
    health: sendingNumber ? await readSendingHealth(sendingNumber) : null,
  });
}
