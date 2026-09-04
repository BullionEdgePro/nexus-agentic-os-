import { env } from "../config/env.js";
import { whatsappSendTokenForNumber } from "@nexus/db";
import { logger } from "./logger.js";

/**
 * The bearer token a send from THIS number must use.
 *
 * A coexistence number lives on a staff member's own WhatsApp Business Account,
 * which the shared system-user token cannot send from — so a reply from it goes
 * out with the token captured when that number was connected. Every other number
 * (the shared company line, dedicated numbers on the platform's own WABA) has no
 * such connection row, resolves to null, and correctly uses the shared token.
 *
 * Resolved here rather than at each call site so no sender can forget it: text
 * replies, twin replies, human replies and the fallback all pass through the two
 * functions below. A lookup failure falls back to the shared token rather than
 * blocking the send — the overwhelming majority of traffic is the shared number,
 * and a genuine coexistence send that ends up on the wrong token simply fails at
 * Meta and surfaces as "reconnect", which is better than refusing every send.
 */
async function bearerFor(phoneNumberId: string): Promise<string> {
  try {
    const token = await whatsappSendTokenForNumber(phoneNumberId);
    if (token) return token;
  } catch (err) {
    logger.warn({ err, phoneNumberId }, "Could not resolve a per-number send token; using the shared token");
  }
  return env.metaAccessToken;
}

/**
 * Meta's id for a message we sent — the `wamid` — or null if it did not give one.
 *
 * This is the only handle that exists on a sent message. Delivery is reported
 * asynchronously on the inbound webhook as `value.statuses[]`, and a status
 * carries the wamid and nothing else that identifies what it refers to. Both
 * senders returned `void` until 2026-08-17, so every outbound row in this
 * database was written with a null `wa_message_id` and the literal status
 * 'sent' — a claim about a message nobody could look up afterwards.
 *
 * Nullable rather than thrown on, because a missing id is not a failed send:
 * Meta accepted it. Losing the receipt is worth recording and is not worth
 * refusing to save the message over.
 */
export type SentMessageId = string | null;

function readWamid(payload: unknown): SentMessageId {
  const messages = (payload as { messages?: Array<{ id?: unknown }> } | null)?.messages;
  const id = Array.isArray(messages) ? messages[0]?.id : undefined;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function sendWhatsAppText(
  phoneNumberId: string,
  toWaId: string,
  body: string
): Promise<SentMessageId> {
  const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bearerFor(phoneNumberId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "text",
      text: { body },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${errorBody}`);
  }

  // A 200 means ACCEPTED, not delivered. That distinction is the whole reason
  // this function stopped returning void: without the id there is no way to
  // learn, later, which of the two it turned out to be.
  return readWamid(await response.json().catch(() => null));
}

/** Sends a pre-approved Meta message template — the only message type allowed outside a 24h session window. */
export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  toWaId: string,
  templateName: string,
  language: string,
  bodyParams: string[] = []
): Promise<SentMessageId> {
  const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await bearerFor(phoneNumberId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toWaId,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        // Meta rejects a send whose parameter count does not match the approved
        // template exactly, so an empty list must omit the components key
        // rather than send an empty one.
        ...(bodyParams.length
          ? {
              components: [
                {
                  type: "body",
                  parameters: bodyParams.map((text) => ({ type: "text", text })),
                },
              ],
            }
          : {}),
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WhatsApp template send failed (${response.status}): ${errorBody}`);
  }

  // Templates go to people who have NOT messaged in 24 hours, which is the case
  // most likely to be accepted and then rejected downstream — a stale number, a
  // recipient who never opted in. The receipt matters more here, not less.
  return readWamid(await response.json().catch(() => null));
}

// ============================================================
// Message templates
//
// A template is the only thing WhatsApp lets a business send to someone who
// has not messaged them in the last 24 hours, and Meta — not this platform —
// decides whether one may be used. So templates are read from Meta rather than
// declared locally: our table is a mirror, and `is_approved` is Meta's answer,
// never ours.
// ============================================================

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  /** Number of {{n}} placeholders in the body, so a send can supply exactly that many. */
  bodyParamCount: number;
}

function countBodyParams(components: unknown): number {
  if (!Array.isArray(components)) return 0;
  const body = components.find(
    (component) => (component as { type?: string })?.type?.toUpperCase() === "BODY"
  ) as { text?: string } | undefined;
  if (!body?.text) return 0;
  // Distinct placeholders, not occurrences: "{{1}} ... {{1}}" is one parameter,
  // and counting it twice would make every send fail on a count mismatch.
  return new Set(body.text.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
}

export async function listMetaTemplates(wabaId: string): Promise<MetaTemplate[]> {
  const templates: MetaTemplate[] = [];
  let url =
    `https://graph.facebook.com/${env.metaGraphApiVersion}/${wabaId}/message_templates` +
    `?limit=100&access_token=${encodeURIComponent(env.metaAccessToken)}`;

  // Paged deliberately. Reading only the first page would silently drop
  // templates once the account has more than a hundred, and the symptom would
  // be a template that exists at Meta but never appears in the picker.
  for (let page = 0; page < 20 && url; page++) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Listing templates failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
      paging?: { next?: string };
    };

    for (const row of payload.data ?? []) {
      templates.push({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        language: String(row.language ?? "en"),
        category: row.category ? String(row.category) : null,
        status: String(row.status ?? "UNKNOWN"),
        bodyParamCount: countBodyParams(row.components),
      });
    }

    url = payload.paging?.next ?? "";
  }

  return templates;
}

export interface TemplateSpec {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING";
  body: string;
  /** One sample value per placeholder — Meta rejects a parameterised template without them. */
  example: string[];
  /**
   * Quick-reply buttons, by label.
   *
   * Added for one reason: a MARKETING template needs a way to stop it. Meta's
   * policy expects marketing messages to honour opt-out, and on this
   * deployment the quality rating a spam report damages belongs to ONE number
   * that six businesses answer on. A button sends its own label back as an
   * ordinary inbound message, which is what `looksLikeAnOptOut` matches.
   */
  buttons?: string[];
}

export interface CreateTemplateResult {
  name: string;
  ok: boolean;
  id?: string;
  status?: string;
  error?: string;
}

export async function createMetaTemplate(
  wabaId: string,
  spec: TemplateSpec
): Promise<CreateTemplateResult> {
  const response = await fetch(
    `https://graph.facebook.com/${env.metaGraphApiVersion}/${wabaId}/message_templates`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.metaAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: spec.name,
        language: spec.language,
        category: spec.category,
        components: [
          {
            type: "BODY",
            text: spec.body,
            ...(spec.example.length ? { example: { body_text: [spec.example] } } : {}),
          },
          // Omitted entirely when there are none. An empty BUTTONS component is
          // a validation error at Meta rather than a no-op, so the five utility
          // templates already on the account must keep submitting exactly what
          // they submitted before.
          ...(spec.buttons?.length
            ? [
                {
                  type: "BUTTONS",
                  buttons: spec.buttons.map((text) => ({ type: "QUICK_REPLY", text })),
                },
              ]
            : []),
        ],
      }),
    }
  );

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    error?: { message?: string; error_user_msg?: string };
  };

  if (!response.ok) {
    return {
      name: spec.name,
      ok: false,
      error: payload.error?.error_user_msg ?? payload.error?.message ?? `HTTP ${response.status}`,
    };
  }

  return { name: spec.name, ok: true, id: payload.id, status: payload.status };
}

export interface WabaNumber {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string | null;
}

/**
 * Every number registered on a WhatsApp Business Account.
 *
 * ============================================================
 * THE ONLY HONEST WAY TO SAY "CONNECTED"
 * ============================================================
 *
 * A staff member typing their mobile number into a settings box has connected
 * nothing. Sending is `POST /{phone_number_id}/messages` against one access
 * token, so a number can only ever send if Meta already holds it on this
 * account — and that is a question with a real answer, asked here rather than
 * assumed.
 *
 * The alternative, storing whatever was typed and finding out at send time, is
 * how a campaign reports "queued" to five hundred people and delivers to none.
 *
 * NOT cached. This is asked when somebody is setting a number up and when a
 * campaign is about to go out; both are rare, and a stale yes is worse than a
 * slow no.
 */
export async function listWabaNumbers(wabaId: string): Promise<WabaNumber[]> {
  const url =
    `https://graph.facebook.com/${env.metaGraphApiVersion}/${wabaId}/phone_numbers` +
    `?fields=id,display_phone_number,verified_name,quality_rating&limit=100` +
    `&access_token=${encodeURIComponent(env.metaAccessToken)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Listing WhatsApp numbers failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).map((row) => ({
    phoneNumberId: String(row.id ?? ""),
    displayPhoneNumber: String(row.display_phone_number ?? ""),
    verifiedName: String(row.verified_name ?? ""),
    qualityRating: row.quality_rating ? String(row.quality_rating) : null,
  }));
}

export interface AccountStanding {
  /** Meta's business verification: "verified", "not_verified", "rejected", "pending". */
  businessVerification: string | null;
  /** Review state of the WhatsApp account itself. */
  accountReview: string | null;
  displayNumber: string;
  /** GREEN / YELLOW / RED — how recipients have been reacting. */
  quality: string | null;
  /** TIER_250, TIER_1K, TIER_10K, TIER_100K, TIER_UNLIMITED. */
  tier: string | null;
  /** How many unique customers this number may start conversations with per day. */
  dailyCustomerLimit: number | null;
}

const TIER_LIMITS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
};

/** The number in a tier string, or null for unlimited and for anything unrecognised. */
export function tierToDailyLimit(tier: string | null | undefined): number | null {
  if (!tier) return null;
  return TIER_LIMITS[tier.toUpperCase()] ?? null;
}

/**
 * How this WhatsApp account is actually doing, as Meta sees it.
 *
 * ============================================================
 * NOBODY WAS WATCHING THE THING EVERYTHING DEPENDS ON
 * ============================================================
 *
 * Twenty-three operators watch conversations, knowledge, staff, bookings and
 * jobs. Not one watched whether the NUMBER carrying all six businesses is in
 * good standing — its quality rating, its daily ceiling, or whether the
 * business behind it is verified.
 *
 * Those are the facts that decide whether any of the rest reaches anybody. A
 * number that has slipped to RED is rate-limited by Meta, so the symptom is
 * replies arriving late or not at all, which looks exactly like a platform
 * fault and is not one. And an unverified business is capped at 250 unique
 * customers a day across every business on the number — a ceiling nobody would
 * discover until a campaign quietly stopped delivering partway through.
 *
 * Read from Meta each time rather than cached. It is asked once per sweep.
 */
export async function readAccountStanding(wabaId: string): Promise<AccountStanding | null> {
  const account = await fetch(
    `https://graph.facebook.com/${env.metaGraphApiVersion}/${wabaId}` +
      `?fields=account_review_status,business_verification_status` +
      `&access_token=${encodeURIComponent(env.metaAccessToken)}`
  );
  if (!account.ok) {
    throw new Error(`Reading account standing failed (${account.status}): ${await account.text()}`);
  }
  const accountJson = (await account.json()) as Record<string, unknown>;

  const numbers = await fetch(
    `https://graph.facebook.com/${env.metaGraphApiVersion}/${wabaId}/phone_numbers` +
      `?fields=display_phone_number,quality_rating,messaging_limit_tier` +
      `&access_token=${encodeURIComponent(env.metaAccessToken)}`
  );
  if (!numbers.ok) {
    throw new Error(`Reading number standing failed (${numbers.status}): ${await numbers.text()}`);
  }
  const numbersJson = (await numbers.json()) as { data?: Array<Record<string, unknown>> };
  const first = numbersJson.data?.[0];
  if (!first) return null;

  const tier = first.messaging_limit_tier ? String(first.messaging_limit_tier) : null;
  return {
    businessVerification: accountJson.business_verification_status
      ? String(accountJson.business_verification_status)
      : null,
    accountReview: accountJson.account_review_status ? String(accountJson.account_review_status) : null,
    displayNumber: String(first.display_phone_number ?? ""),
    quality: first.quality_rating ? String(first.quality_rating) : null,
    tier,
    dailyCustomerLimit: tierToDailyLimit(tier),
  };
}
