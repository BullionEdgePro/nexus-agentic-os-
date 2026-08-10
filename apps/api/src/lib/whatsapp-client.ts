import { env } from "../config/env.js";

export async function sendWhatsAppText(phoneNumberId: string, toWaId: string, body: string): Promise<void> {
  const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.metaAccessToken}`,
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
}

/** Sends a pre-approved Meta message template — the only message type allowed outside a 24h session window. */
export async function sendWhatsAppTemplate(
  phoneNumberId: string,
  toWaId: string,
  templateName: string,
  language: string,
  bodyParams: string[] = []
): Promise<void> {
  const url = `https://graph.facebook.com/${env.metaGraphApiVersion}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.metaAccessToken}`,
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
