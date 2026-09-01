/**
 * A staff member's self-reported social presence — where they carry their link.
 *
 * ============================================================
 * SELF-REPORTED, NOT CONNECTED
 * ============================================================
 *
 * This is a plain list a person types in: platform, a name or handle, and a
 * link. It is NOT an authenticated connection — there is no token here, and
 * nothing in it can read a DM. Connected accounts (Gmail; TikTok if un-parked)
 * live in social_connections and are a different thing entirely. Conflating the
 * two is how a "just note your handle" box quietly grows into an OAuth flow, so
 * they are kept apart on purpose.
 *
 * ============================================================
 * VALIDATED ON THE WAY IN
 * ============================================================
 *
 * jsonb accepts any shape, so the same lesson as the rota applies: a mistyped
 * entry that stores cleanly and reads back as nonsense is worse than a rejection.
 * Every row is normalised here — platform lowercased to a known set, label
 * trimmed and required, url trimmed and shape-checked — and the whole list is
 * capped so nobody can paste a novel into it.
 */

import { SOCIAL_PLATFORMS, type SocialAccount, type SocialPlatform } from "@nexus/shared";

export interface SocialAccountsValidation {
  ok: boolean;
  errors: string[];
  /** Present only when ok — normalised, safe to store. */
  accounts?: SocialAccount[];
}

const PLATFORM_SET: ReadonlySet<string> = new Set(SOCIAL_PLATFORMS);
const MAX_ACCOUNTS = 25;
const MAX_LABEL = 100;
const MAX_URL = 300;

/**
 * A URL is optional, but if one is given it must at least look like a web
 * address — a bare "instagram.com/foo" typed without a scheme is upgraded
 * rather than rejected, because that is what a person types and refusing it
 * teaches nothing.
 */
function normaliseUrl(raw: string): { url: string; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { url: "", error: null };
  if (trimmed.length > MAX_URL) return { url: "", error: `A link is longer than ${MAX_URL} characters.` };
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    // Constructing a URL is the check: it throws on something that is not one.
    const parsed = new URL(withScheme);
    if (!parsed.hostname.includes(".")) {
      return { url: "", error: `"${trimmed}" does not look like a link.` };
    }
    return { url: parsed.toString(), error: null };
  } catch {
    return { url: "", error: `"${trimmed}" does not look like a link.` };
  }
}

export function parseSocialAccounts(input: unknown): SocialAccountsValidation {
  if (input === null || input === undefined) return { ok: true, errors: [], accounts: [] };
  if (!Array.isArray(input)) {
    return { ok: false, errors: ["Social accounts must be a list."] };
  }
  if (input.length > MAX_ACCOUNTS) {
    return { ok: false, errors: [`That is more than ${MAX_ACCOUNTS} accounts — remove a few.`] };
  }

  const errors: string[] = [];
  const accounts: SocialAccount[] = [];

  input.forEach((raw, index) => {
    const at = `Row ${index + 1}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${at} is not a valid account.`);
      return;
    }
    const row = raw as Record<string, unknown>;

    const platform = typeof row.platform === "string" ? row.platform.trim().toLowerCase() : "";
    if (!PLATFORM_SET.has(platform)) {
      errors.push(`${at}: "${row.platform ?? ""}" is not a platform we know — pick one from the list.`);
      return;
    }

    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!label) {
      errors.push(`${at}: give the account a name or handle.`);
      return;
    }
    if (label.length > MAX_LABEL) {
      errors.push(`${at}: the name is longer than ${MAX_LABEL} characters.`);
      return;
    }

    const { url, error } = normaliseUrl(typeof row.url === "string" ? row.url : "");
    if (error) {
      errors.push(`${at}: ${error}`);
      return;
    }

    accounts.push({ platform: platform as SocialPlatform, label, url });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], accounts };
}
