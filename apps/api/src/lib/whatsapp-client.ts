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
  language: string
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
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`WhatsApp template send failed (${response.status}): ${errorBody}`);
  }
}
