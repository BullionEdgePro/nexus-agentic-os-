import {
  latestHqChecks,
  getHqProfile,
  listHqKeywords,
  listHqSocialAccounts,
  listVaultEntries,
} from "@nexus/db";
import { hqIssues, scoreHealth, type HqIssue, type HqState } from "@nexus/shared";

/**
 * Everything the health rules read for one business, gathered in one place so
 * the daily job and the dashboard judge a business identically.
 */
export async function buildHqState(organizationId: string): Promise<HqState> {
  const [checks, profile, keywords, socials, vault] = await Promise.all([
    latestHqChecks(organizationId),
    getHqProfile(organizationId),
    listHqKeywords(organizationId),
    listHqSocialAccounts(organizationId),
    listVaultEntries(organizationId),
  ]);
  return {
    checks: Object.fromEntries(
      Object.entries(checks).map(([kind, c]) => [kind, { ok: c!.ok, data: c!.data, error: c!.error, ranAt: c!.ranAt }])
    ),
    profile: profile
      ? { gbpUrl: profile.gbpUrl, gbpLastPostAt: profile.gbpLastPostAt, gbpLastPhotoAt: profile.gbpLastPhotoAt }
      : null,
    keywords: keywords.map((k) => ({ keyword: k.keyword, checkedAt: k.checkedAt })),
    socials: socials.map((s) => ({ platform: s.platform, handle: s.handle, lastPostAt: s.lastPostAt, twoFactor: s.twoFactor })),
    vault: vault.map((v) => ({ service: v.service, label: v.label, hasSecret: v.hasSecret, secretChangedAt: v.secretChangedAt })),
  };
}

/** The issues and score for one business, now. */
export async function judgeBusiness(organizationId: string, now = new Date()): Promise<{ state: HqState; issues: HqIssue[]; score: number }> {
  const state = await buildHqState(organizationId);
  const issues = hqIssues(state, now);
  return { state, issues, score: scoreHealth(issues) };
}
