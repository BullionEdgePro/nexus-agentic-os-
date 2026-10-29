import { env } from "../config/env.js";
import { getRedisConnection } from "../queue/queue.js";
import { logger } from "./logger.js";

/**
 * The words of an approved WhatsApp message, as the customer will read them.
 *
 * The pickers listed approved messages by Meta's name — `zipicka_promotions`,
 * `sfs_general_update` — and nothing else (29 Oct 2026). Staff were choosing
 * what to send to their whole book by a filename. The mirror keeps names and
 * approval state only, so the text is asked of Meta by name on the account the
 * message is approved on, and cached: approved wording cannot change without a
 * new approval, and the picker is opened far more often than templates move.
 */

export interface TemplateText {
  header: string | null;
  body: string;
  footer: string | null;
  buttons: string[];
}

const KEY = (wabaId: string, name: string, language: string) => `tpl-text:${wabaId}:${name}:${language}`;
const TTL_SECONDS = 6 * 3600;

/** Meta's components, reduced to what a person reads. Exported for its test. */
export function textFromComponents(components: unknown): TemplateText | null {
  if (!Array.isArray(components)) return null;
  let header: string | null = null;
  let body = "";
  let footer: string | null = null;
  const buttons: string[] = [];
  for (const raw of components) {
    const component = raw as { type?: string; format?: string; text?: string; buttons?: Array<{ text?: string }> };
    const type = String(component.type ?? "").toUpperCase();
    if (type === "HEADER") {
      header = component.format && component.format !== "TEXT" ? `[${component.format.toLowerCase()}]` : component.text ?? null;
    } else if (type === "BODY") {
      body = component.text ?? "";
    } else if (type === "FOOTER") {
      footer = component.text ?? null;
    } else if (type === "BUTTONS") {
      for (const button of component.buttons ?? []) if (button.text) buttons.push(button.text);
    }
  }
  return body ? { header, body, footer, buttons } : null;
}

/**
 * The text of one approved message, or null when Meta does not have it (or
 * did not answer). Never throws: a picker without a preview still works.
 */
export async function fetchTemplateText(
  wabaId: string,
  name: string,
  language: string,
  accessToken: string = env.metaAccessToken
): Promise<TemplateText | null> {
  const redis = getRedisConnection();
  try {
    const cached = await redis.get(KEY(wabaId, name, language));
    if (cached) return JSON.parse(cached) as TemplateText;
  } catch {
    // A cache that cannot be read is a slower preview, not a missing one.
  }
  try {
    const url =
      `https://graph.facebook.com/${env.metaGraphApiVersion}/${wabaId}/message_templates` +
      `?name=${encodeURIComponent(name)}&fields=name,language,components&limit=50`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      logger.warn({ wabaId, name, status: response.status }, "Could not read a template's text from Meta");
      return null;
    }
    const payload = (await response.json()) as { data?: Array<{ name?: string; language?: string; components?: unknown }> };
    const match = (payload.data ?? []).find((row) => row.name === name && row.language === language);
    const text = match ? textFromComponents(match.components) : null;
    if (text) await redis.set(KEY(wabaId, name, language), JSON.stringify(text), "EX", TTL_SECONDS).catch(() => undefined);
    return text;
  } catch (err) {
    logger.warn({ err, wabaId, name }, "Could not read a template's text from Meta");
    return null;
  }
}
