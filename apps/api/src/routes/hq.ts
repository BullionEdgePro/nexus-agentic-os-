import { Hono, type Context } from "hono";
import {
  listHqBusinesses,
  getHqProfile,
  upsertHqProfile,
  listHqKeywords,
  upsertHqKeyword,
  deleteHqKeyword,
  listHqSocialAccounts,
  upsertHqSocialAccount,
  deleteHqSocialAccount,
  listVaultEntries,
  upsertVaultEntry,
  softDeleteVaultEntry,
  listVaultReveals,
  latestHqChecks,
  listConnections,
  sealVaultSecret,
  vaultConfigured,
  withTenant,
  type HqBusiness,
  type HqProfileFields,
  type HqSocialPlatform,
  type VaultSection,
} from "@nexus/db";
import { looksLikeCardNumber, safeHttpUrl } from "@nexus/shared";
import type { SessionScope } from "../lib/session.js";
import { judgeBusiness } from "../services/hq-state.js";
import { unlockVault, lockVault, vaultUnlockedFor, revealVaultSecret } from "../services/vault-unlock.js";
import { enqueueHqCheckNow } from "../queue/hq-checks-queue.js";
import { logger } from "../lib/logger.js";

/**
 * Business HQ (spec 2026-10-14-business-hq-design.md). Mounted behind
 * operatorOnly in index.ts: staff never reach any of this.
 *
 * Nothing here returns a sealed password. The vault list is the public shape
 * (no secret field); a password leaves the server only through /reveal, which
 * needs the admin's live unlock window and is logged first. The admin is always
 * the session's — no id from a request body is ever trusted.
 */
export const hqRoute = new Hono();

const CARD_REFUSAL = "Card numbers do not belong here — use a payment manager.";
const LINK_REFUSAL = "Links must start with http:// or https://.";

/** A link field: absent or empty is null; anything but http(s) is refused. */
function linkField(value: unknown): { ok: true; url: string | null } | { ok: false } {
  const raw = str(value, 500);
  if (!raw) return { ok: true, url: null };
  const url = safeHttpUrl(raw);
  return url ? { ok: true, url } : { ok: false };
}
const PLATFORMS: HqSocialPlatform[] = ["facebook", "instagram", "tiktok", "linkedin", "youtube", "x", "snapchat", "google_business", "other"];
const SECTIONS: VaultSection[] = ["website", "social", "other"];

function scopeOf(c: Context): SessionScope | undefined {
  return c.get("scope") as SessionScope | undefined;
}

/** The signed-in admin's id, or null for a session that is not a named admin. */
function adminIdOf(c: Context): string | null {
  const scope = scopeOf(c);
  return scope?.role === "operator" && scope.adminId ? scope.adminId : null;
}

const NO_ADMIN = { error: "Sign in with your own admin account to use the vault." } as const;

async function businessBySlug(slug: string | undefined): Promise<HqBusiness | null> {
  if (!slug || slug === "review-demo") return null;
  return (await listHqBusinesses()).find((b) => b.slug === slug && b.isActive) ?? null;
}

const str = (v: unknown, max = 500): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const date = (v: unknown): string | null => (typeof v === "string" && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const hasCard = (values: unknown[]) => values.some((v) => typeof v === "string" && looksLikeCardNumber(v));

// ---------- the businesses ----------

hqRoute.get("/", async (c) => {
  const businesses = (await listHqBusinesses()).filter((b) => b.isActive && b.slug !== "review-demo");
  const cards = await Promise.all(
    businesses.map(async (b) => {
      const { issues, score } = await judgeBusiness(b.id);
      return { slug: b.slug, name: b.name, logoUrl: b.logoUrl, websiteUrl: b.websiteUrl, score, topIssues: issues.slice(0, 3), issueCount: issues.length };
    })
  );
  return c.json({ businesses: cards.sort((a, b) => a.score - b.score) });
});

hqRoute.get("/:slug", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const adminId = adminIdOf(c);

  const [{ issues, score }, profile, checks, keywords, socials, vault, reveals, connections] = await Promise.all([
    judgeBusiness(business.id),
    getHqProfile(business.id),
    latestHqChecks(business.id),
    listHqKeywords(business.id),
    listHqSocialAccounts(business.id),
    listVaultEntries(business.id),
    listVaultReveals(business.id),
    withTenant(business.id, () => listConnections(business.id, null)).catch(() => []),
  ]);

  // The Facebook Page and Instagram account already connected to Nexus fill
  // the social tab until somebody records them by hand.
  const recorded = new Set(socials.map((s) => s.platform));
  const connected = connections
    .filter((conn) => (conn.provider === "facebook" || conn.provider === "instagram") && !recorded.has(conn.provider as HqSocialPlatform))
    .map((conn) => ({
      id: `connected-${conn.provider}`,
      platform: conn.provider,
      handle: conn.displayName,
      url:
        conn.provider === "facebook"
          ? `https://facebook.com/${conn.externalId}`
          : conn.displayName
            ? `https://instagram.com/${conn.displayName.replace(/^@/, "")}`
            : null,
      followers: null,
      lastPostAt: null,
      twoFactor: null,
      recoveryContact: null,
      vaultEntryId: null,
      updatedAt: conn.connectedAt,
      source: "connected" as const,
    }));

  return c.json({
    business: { slug: business.slug, name: business.name, logoUrl: business.logoUrl, websiteUrl: business.websiteUrl },
    profile,
    checks,
    issues,
    score,
    keywords,
    socials: [...socials.map((s) => ({ ...s, source: "recorded" as const })), ...connected],
    vault,
    reveals,
    vaultConfigured: vaultConfigured(),
    unlockedSeconds: adminId ? await vaultUnlockedFor(adminId) : 0,
  });
});

// ---------- profile, keywords, socials ----------

hqRoute.put("/:slug/profile", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (hasCard(Object.values(body))) return c.json({ error: CARD_REFUSAL }, 422);
  const patch: Partial<HqProfileFields> = {};
  if ("domain" in body) patch.domain = str(body.domain, 253);
  for (const k of ["registrarNote", "hostingNote", "platformNote", "notes"] as const) if (k in body) patch[k] = str(body[k], 2000);
  if ("gbpUrl" in body) {
    const link = linkField(body.gbpUrl);
    if (!link.ok) return c.json({ error: LINK_REFUSAL }, 400);
    patch.gbpUrl = link.url;
  }
  if ("gbpRating" in body) patch.gbpRating = num(body.gbpRating);
  if ("gbpReviewCount" in body) patch.gbpReviewCount = num(body.gbpReviewCount);
  if ("gbpUnansweredReviews" in body) patch.gbpUnansweredReviews = num(body.gbpUnansweredReviews);
  if ("gbpLastPostAt" in body) patch.gbpLastPostAt = date(body.gbpLastPostAt);
  if ("gbpLastPhotoAt" in body) patch.gbpLastPhotoAt = date(body.gbpLastPhotoAt);
  const profile = await upsertHqProfile(business.id, patch, adminIdOf(c) ?? "operator");
  return c.json({ profile });
});

hqRoute.post("/:slug/keywords", async (c) => saveKeyword(c, undefined));
hqRoute.put("/:slug/keywords/:id", async (c) => saveKeyword(c, c.req.param("id")));
async function saveKeyword(c: Context, id: string | undefined) {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (hasCard(Object.values(body))) return c.json({ error: CARD_REFUSAL }, 422);
  const keyword = str(body.keyword, 120);
  if (!keyword) return c.json({ error: "Write the keyword." }, 400);
  const saved = await upsertHqKeyword(business.id, { id, keyword, position: num(body.position), checkedAt: date(body.checkedAt) });
  return saved ? c.json({ keyword: saved }) : c.json({ error: "Keyword not found" }, 404);
}
hqRoute.delete("/:slug/keywords/:id", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  return (await deleteHqKeyword(business.id, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Keyword not found" }, 404);
});

hqRoute.post("/:slug/socials", async (c) => saveSocial(c, undefined));
hqRoute.put("/:slug/socials/:id", async (c) => saveSocial(c, c.req.param("id")));
async function saveSocial(c: Context, id: string | undefined) {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (hasCard(Object.values(body))) return c.json({ error: CARD_REFUSAL }, 422);
  const platform = PLATFORMS.find((p) => p === body.platform);
  if (!platform) return c.json({ error: "Choose the platform." }, 400);
  const link = linkField(body.url);
  if (!link.ok) return c.json({ error: LINK_REFUSAL }, 400);
  const saved = await upsertHqSocialAccount(
    business.id,
    {
      id,
      platform,
      handle: str(body.handle, 120),
      url: link.url,
      followers: num(body.followers),
      lastPostAt: date(body.lastPostAt),
      twoFactor: typeof body.twoFactor === "boolean" ? body.twoFactor : null,
      recoveryContact: str(body.recoveryContact, 200),
      vaultEntryId: str(body.vaultEntryId, 64),
    },
    adminIdOf(c) ?? "operator"
  );
  return saved ? c.json({ social: saved }) : c.json({ error: "Account not found" }, 404);
}
hqRoute.delete("/:slug/socials/:id", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  return (await deleteHqSocialAccount(business.id, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Account not found" }, 404);
});

// ---------- the vault ----------

hqRoute.post("/unlock", async (c) => {
  const adminId = adminIdOf(c);
  if (!adminId) return c.json(NO_ADMIN, 403);
  const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
  const result = await unlockVault(adminId, typeof body.password === "string" ? body.password : "");
  if (result.ok) return c.json({ ok: true, expiresInSeconds: result.expiresInSeconds });
  if (result.reason === "locked-out") {
    return c.json({ error: "Too many wrong passwords. Unlocking is paused for 15 minutes.", retryInSeconds: result.retryInSeconds }, 429);
  }
  // 403, never 401: the web client reads every 401 as "your session expired".
  return c.json({ error: "That password is not right." }, 403);
});

hqRoute.post("/lock", async (c) => {
  const adminId = adminIdOf(c);
  if (adminId) await lockVault(adminId);
  return c.json({ ok: true });
});

hqRoute.post("/:slug/vault", async (c) => saveVaultEntry(c, undefined));
hqRoute.put("/:slug/vault/:id", async (c) => saveVaultEntry(c, c.req.param("id")));
async function saveVaultEntry(c: Context, id: string | undefined) {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const adminId = adminIdOf(c);
  if (!adminId) return c.json(NO_ADMIN, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (hasCard(Object.values(body))) return c.json({ error: CARD_REFUSAL }, 422);
  const section = SECTIONS.find((s) => s === body.section) ?? "other";
  const service = str(body.service, 80);
  if (!service) return c.json({ error: "Name the service (e.g. Hostinger, Instagram)." }, 400);
  const link = linkField(body.url);
  if (!link.ok) return c.json({ error: LINK_REFUSAL }, 400);

  let secretSealed: string | undefined;
  if (typeof body.secret === "string" && body.secret.length > 0) {
    if (!vaultConfigured()) return c.json({ error: "The vault key is not set on the server." }, 503);
    if ((await vaultUnlockedFor(adminId)) === 0) return c.json({ error: "Unlock again" }, 423);
    secretSealed = sealVaultSecret(body.secret.slice(0, 500));
  }

  const entry = await upsertVaultEntry(
    business.id,
    { id, section, service, label: str(body.label, 120), username: str(body.username, 200), url: link.url, notes: str(body.notes, 2000), secretSealed },
    adminId
  );
  return entry ? c.json({ entry }) : c.json({ error: "Login not found" }, 404);
}

hqRoute.delete("/:slug/vault/:id", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const adminId = adminIdOf(c);
  if (!adminId) return c.json(NO_ADMIN, 403);
  return (await softDeleteVaultEntry(business.id, c.req.param("id"), adminId)) ? c.json({ ok: true }) : c.json({ error: "Login not found" }, 404);
});

hqRoute.post("/:slug/vault/:id/reveal", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const adminId = adminIdOf(c);
  if (!adminId) return c.json(NO_ADMIN, 403);
  const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() || null;
  const userAgent = c.req.header("user-agent") ?? null;
  const result = await revealVaultSecret({ orgId: business.id, entryId: c.req.param("id"), adminId, ip, userAgent });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  logger.info({ adminId, business: business.slug, entryId: c.req.param("id") }, "Business HQ password revealed");
  return c.json({ secret: result.secret });
});

// ---------- check now ----------

hqRoute.post("/:slug/check", async (c) => {
  const business = await businessBySlug(c.req.param("slug"));
  if (!business) return c.json({ error: "Business not found" }, 404);
  const outcome = await enqueueHqCheckNow(business.id);
  return outcome === "queued" ? c.json({ queued: true }, 202) : c.json({ error: "Checked less than 5 minutes ago." }, 429);
});
