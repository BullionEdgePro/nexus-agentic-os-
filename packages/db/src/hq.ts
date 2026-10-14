import { getPool, withAllTenants } from "./client.js";

/**
 * Business HQ data (migration 097, spec 2026-10-14-business-hq-design.md).
 *
 * Read and written only by the admin-only /api/hq routes, which work across
 * every business, so every function names its cross-tenant reason. The vault's
 * listing never selects the sealed password: the only way to it is
 * getVaultSecretSealed, which the reveal path calls after an unlock check.
 */

export type HqCheckKind = "rdap" | "dns" | "tls" | "http" | "speed" | "seo" | "platform";
export const HQ_CHECK_KINDS: HqCheckKind[] = ["rdap", "dns", "tls", "http", "speed", "seo", "platform"];

export interface HqProfileFields {
  domain: string | null;
  registrarNote: string | null;
  hostingNote: string | null;
  platformNote: string | null;
  gbpUrl: string | null;
  gbpRating: number | null;
  gbpReviewCount: number | null;
  gbpUnansweredReviews: number | null;
  gbpLastPostAt: string | null;
  gbpLastPhotoAt: string | null;
  notes: string | null;
}
export interface HqProfile extends HqProfileFields {
  organizationId: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface HqKeyword {
  id: string;
  keyword: string;
  position: number | null;
  checkedAt: string | null;
}

export type HqSocialPlatform =
  | "facebook" | "instagram" | "tiktok" | "linkedin" | "youtube" | "x" | "snapchat" | "google_business" | "other";

export interface HqSocialAccount {
  id: string;
  platform: HqSocialPlatform;
  handle: string | null;
  url: string | null;
  followers: number | null;
  lastPostAt: string | null;
  twoFactor: boolean | null;
  recoveryContact: string | null;
  vaultEntryId: string | null;
  updatedAt: string;
}

export type VaultSection = "website" | "social" | "other";

/** A vault entry as any list shows it: everything except the password. */
export interface VaultEntryPublic {
  id: string;
  section: VaultSection;
  service: string;
  label: string | null;
  username: string | null;
  url: string | null;
  notes: string | null;
  hasSecret: boolean;
  secretChangedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface VaultReveal {
  id: string;
  entryId: string;
  service: string;
  adminId: string;
  adminName: string | null;
  revealedAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface HqCheckRow {
  kind: HqCheckKind;
  ranAt: string;
  ok: boolean | null;
  data: Record<string, unknown>;
  error: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

// ---------- profile ----------

const PROFILE_COLUMNS: Record<keyof HqProfileFields, string> = {
  domain: "domain",
  registrarNote: "registrar_note",
  hostingNote: "hosting_note",
  platformNote: "platform_note",
  gbpUrl: "gbp_url",
  gbpRating: "gbp_rating",
  gbpReviewCount: "gbp_review_count",
  gbpUnansweredReviews: "gbp_unanswered_reviews",
  gbpLastPostAt: "gbp_last_post_at",
  gbpLastPhotoAt: "gbp_last_photo_at",
  notes: "notes",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProfile(r: any): HqProfile {
  return {
    organizationId: r.organization_id,
    domain: r.domain,
    registrarNote: r.registrar_note,
    hostingNote: r.hosting_note,
    platformNote: r.platform_note,
    gbpUrl: r.gbp_url,
    gbpRating: r.gbp_rating == null ? null : Number(r.gbp_rating),
    gbpReviewCount: r.gbp_review_count,
    gbpUnansweredReviews: r.gbp_unanswered_reviews,
    gbpLastPostAt: iso(r.gbp_last_post_at),
    gbpLastPhotoAt: iso(r.gbp_last_photo_at),
    notes: r.notes,
    updatedAt: iso(r.updated_at)!,
    updatedBy: r.updated_by,
  };
}

export async function getHqProfile(organizationId: string): Promise<HqProfile | null> {
  return withAllTenants("business hq: read a business's profile", async () => {
    const { rows } = await getPool().query(`select * from hq_profiles where organization_id = $1`, [organizationId]);
    return rows[0] ? toProfile(rows[0]) : null;
  });
}

/** Write only the fields given; the rest keep their value. */
export async function upsertHqProfile(
  organizationId: string,
  patch: Partial<HqProfileFields>,
  adminId: string
): Promise<HqProfile> {
  return withAllTenants("business hq: update a business's profile", async () => {
    const keys = (Object.keys(patch) as (keyof HqProfileFields)[]).filter((k) => k in PROFILE_COLUMNS);
    const cols = keys.map((k) => PROFILE_COLUMNS[k]);
    const values = keys.map((k) => patch[k] ?? null);
    const insertCols = ["organization_id", "updated_by", ...cols].join(", ");
    const placeholders = ["$1", "$2", ...cols.map((_, i) => `$${i + 3}`)].join(", ");
    const updates = ["updated_at = now()", "updated_by = excluded.updated_by", ...cols.map((c) => `${c} = excluded.${c}`)].join(", ");
    const { rows } = await getPool().query(
      `insert into hq_profiles (${insertCols}) values (${placeholders})
       on conflict (organization_id) do update set ${updates}
       returning *`,
      [organizationId, adminId, ...values]
    );
    return toProfile(rows[0]);
  });
}

// ---------- keywords ----------

export async function listHqKeywords(organizationId: string): Promise<HqKeyword[]> {
  return withAllTenants("business hq: list keywords", async () => {
    const { rows } = await getPool().query(
      `select id, keyword, position, checked_at from hq_keywords where organization_id = $1 order by keyword`,
      [organizationId]
    );
    return rows.map((r) => ({ id: r.id, keyword: r.keyword, position: r.position, checkedAt: iso(r.checked_at) }));
  });
}

export async function upsertHqKeyword(
  organizationId: string,
  input: { id?: string; keyword: string; position: number | null; checkedAt: string | null }
): Promise<HqKeyword | null> {
  return withAllTenants("business hq: save a keyword", async () => {
    const { rows } = input.id
      ? await getPool().query(
          `update hq_keywords set keyword = $3, position = $4, checked_at = $5
            where id = $1 and organization_id = $2 returning id, keyword, position, checked_at`,
          [input.id, organizationId, input.keyword, input.position, input.checkedAt]
        )
      : await getPool().query(
          `insert into hq_keywords (organization_id, keyword, position, checked_at) values ($1, $2, $3, $4)
           returning id, keyword, position, checked_at`,
          [organizationId, input.keyword, input.position, input.checkedAt]
        );
    const r = rows[0];
    return r ? { id: r.id, keyword: r.keyword, position: r.position, checkedAt: iso(r.checked_at) } : null;
  });
}

export async function deleteHqKeyword(organizationId: string, id: string): Promise<boolean> {
  return withAllTenants("business hq: delete a keyword", async () => {
    const { rowCount } = await getPool().query(`delete from hq_keywords where id = $1 and organization_id = $2`, [id, organizationId]);
    return (rowCount ?? 0) > 0;
  });
}

// ---------- social accounts ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSocial(r: any): HqSocialAccount {
  return {
    id: r.id,
    platform: r.platform,
    handle: r.handle,
    url: r.url,
    followers: r.followers,
    lastPostAt: iso(r.last_post_at),
    twoFactor: r.two_factor,
    recoveryContact: r.recovery_contact,
    vaultEntryId: r.vault_entry_id,
    updatedAt: iso(r.updated_at)!,
  };
}

export async function listHqSocialAccounts(organizationId: string): Promise<HqSocialAccount[]> {
  return withAllTenants("business hq: list social accounts", async () => {
    const { rows } = await getPool().query(
      `select * from hq_social_accounts where organization_id = $1 order by platform, handle`,
      [organizationId]
    );
    return rows.map(toSocial);
  });
}

export async function upsertHqSocialAccount(
  organizationId: string,
  input: Omit<HqSocialAccount, "id" | "updatedAt"> & { id?: string },
  adminId: string
): Promise<HqSocialAccount | null> {
  return withAllTenants("business hq: save a social account", async () => {
    const values = [
      input.platform, input.handle, input.url, input.followers, input.lastPostAt,
      input.twoFactor, input.recoveryContact, input.vaultEntryId, adminId,
    ];
    const { rows } = input.id
      ? await getPool().query(
          `update hq_social_accounts
              set platform = $3, handle = $4, url = $5, followers = $6, last_post_at = $7,
                  two_factor = $8, recovery_contact = $9, vault_entry_id = $10, updated_by = $11, updated_at = now()
            where id = $1 and organization_id = $2 returning *`,
          [input.id, organizationId, ...values]
        )
      : await getPool().query(
          `insert into hq_social_accounts
             (organization_id, platform, handle, url, followers, last_post_at, two_factor, recovery_contact, vault_entry_id, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
          [organizationId, ...values]
        );
    return rows[0] ? toSocial(rows[0]) : null;
  });
}

export async function deleteHqSocialAccount(organizationId: string, id: string): Promise<boolean> {
  return withAllTenants("business hq: delete a social account", async () => {
    const { rowCount } = await getPool().query(
      `delete from hq_social_accounts where id = $1 and organization_id = $2`,
      [id, organizationId]
    );
    return (rowCount ?? 0) > 0;
  });
}

// ---------- vault ----------

export async function listVaultEntries(organizationId: string): Promise<VaultEntryPublic[]> {
  return withAllTenants("business hq: list vault entries (no passwords)", async () => {
    const { rows } = await getPool().query(
      `select id, section, service, label, username, url, notes,
              (secret_changed_at is not null) as has_secret, secret_changed_at, updated_at, updated_by
         from hq_vault_entries
        where organization_id = $1 and deleted_at is null
        order by section, service, label`,
      [organizationId]
    );
    return rows.map((r) => ({
      id: r.id,
      section: r.section,
      service: r.service,
      label: r.label,
      username: r.username,
      url: r.url,
      notes: r.notes,
      hasSecret: r.has_secret,
      secretChangedAt: iso(r.secret_changed_at),
      updatedAt: iso(r.updated_at)!,
      updatedBy: r.updated_by,
    }));
  });
}

/** The sealed password of one live entry of this business; the caller has already checked the unlock. */
export async function getVaultSecretSealed(organizationId: string, id: string): Promise<string | null> {
  return withAllTenants("business hq: read one sealed vault password for a reveal", async () => {
    const { rows } = await getPool().query(
      `select secret_enc from hq_vault_entries where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, organizationId]
    );
    return rows[0]?.secret_enc ?? null;
  });
}

/**
 * Create or change an entry. `secretSealed` is written only when given, and
 * stamps secret_changed_at; leaving it out keeps the password as it was.
 */
export async function upsertVaultEntry(
  organizationId: string,
  input: {
    id?: string;
    section: VaultSection;
    service: string;
    label: string | null;
    username: string | null;
    url: string | null;
    notes: string | null;
    secretSealed?: string;
  },
  adminId: string
): Promise<VaultEntryPublic | null> {
  const id = await withAllTenants("business hq: save a vault entry", async () => {
    const hasSecret = input.secretSealed !== undefined;
    const { rows } = input.id
      ? await getPool().query(
          `update hq_vault_entries
              set section = $3, service = $4, label = $5, username = $6, url = $7, notes = $8,
                  secret_enc = case when $9 then $10 else secret_enc end,
                  secret_changed_at = case when $9 then now() else secret_changed_at end,
                  updated_by = $11, updated_at = now()
            where id = $1 and organization_id = $2 and deleted_at is null
            returning id`,
          [input.id, organizationId, input.section, input.service, input.label, input.username, input.url, input.notes,
           hasSecret, input.secretSealed ?? null, adminId]
        )
      : await getPool().query(
          `insert into hq_vault_entries
             (organization_id, section, service, label, username, url, notes, secret_enc, secret_changed_at, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8::text is null then null else now() end, $9, $9)
           returning id`,
          [organizationId, input.section, input.service, input.label, input.username, input.url, input.notes,
           input.secretSealed ?? null, adminId]
        );
    return rows[0]?.id as string | undefined;
  });
  if (!id) return null;
  return (await listVaultEntries(organizationId)).find((e) => e.id === id) ?? null;
}

export async function softDeleteVaultEntry(organizationId: string, id: string, adminId: string): Promise<boolean> {
  return withAllTenants("business hq: delete a vault entry (soft)", async () => {
    const { rowCount } = await getPool().query(
      `update hq_vault_entries set deleted_at = now(), updated_by = $3, updated_at = now()
        where id = $1 and organization_id = $2 and deleted_at is null`,
      [id, organizationId, adminId]
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function recordVaultReveal(input: {
  entryId: string;
  organizationId: string;
  adminId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  await withAllTenants("business hq: log a password reveal", async () => {
    await getPool().query(
      `insert into hq_vault_reveals (organization_id, entry_id, admin_id, ip, user_agent) values ($1, $2, $3, $4, $5)`,
      [input.organizationId, input.entryId, input.adminId, input.ip, input.userAgent?.slice(0, 300) ?? null]
    );
  });
}

export async function listVaultReveals(organizationId: string, limit = 50): Promise<VaultReveal[]> {
  return withAllTenants("business hq: read the reveal log", async () => {
    const { rows } = await getPool().query(
      `select r.id, r.entry_id, e.service, r.admin_id, a.full_name as admin_name, r.revealed_at, r.ip, r.user_agent
         from hq_vault_reveals r
         join hq_vault_entries e on e.id = r.entry_id
         left join admins a on a.id::text = r.admin_id
        where r.organization_id = $1
        order by r.revealed_at desc
        limit $2`,
      [organizationId, limit]
    );
    return rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      service: r.service,
      adminId: r.admin_id,
      adminName: r.admin_name,
      revealedAt: iso(r.revealed_at)!,
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  });
}

// ---------- automatic checks ----------

export async function recordHqCheck(input: {
  organizationId: string;
  kind: HqCheckKind;
  ok: boolean | null;
  data: unknown;
  error: string | null;
}): Promise<void> {
  await withAllTenants("business hq: record a check result", async () => {
    await getPool().query(
      `insert into hq_checks (organization_id, kind, ok, data, error) values ($1, $2, $3, $4::jsonb, $5)`,
      [input.organizationId, input.kind, input.ok, JSON.stringify(input.data ?? {}), input.error?.slice(0, 500) ?? null]
    );
    // 90 days of history is plenty to see a trend; older rows go.
    await getPool().query(
      `delete from hq_checks where organization_id = $1 and kind = $2 and ran_at < now() - interval '90 days'`,
      [input.organizationId, input.kind]
    );
  });
}

/** The latest result of each kind; a kind never run is absent. */
export async function latestHqChecks(organizationId: string): Promise<Partial<Record<HqCheckKind, HqCheckRow>>> {
  return withAllTenants("business hq: read the latest checks", async () => {
    const { rows } = await getPool().query(
      `select distinct on (kind) kind, ran_at, ok, data, error
         from hq_checks where organization_id = $1
        order by kind, ran_at desc`,
      [organizationId]
    );
    const out: Partial<Record<HqCheckKind, HqCheckRow>> = {};
    for (const r of rows) out[r.kind as HqCheckKind] = { kind: r.kind, ranAt: iso(r.ran_at)!, ok: r.ok, data: r.data ?? {}, error: r.error };
    return out;
  });
}

// ---------- the businesses ----------

export interface HqBusiness {
  id: string;
  slug: string;
  name: string;
  websiteUrl: string | null;
  logoUrl: string | null;
  isActive: boolean;
}

/** Every business with what HQ needs to check it: its website and logo. */
export async function listHqBusinesses(): Promise<HqBusiness[]> {
  return withAllTenants("business hq: the businesses and their websites", async () => {
    const { rows } = await getPool().query(
      `select id, slug, name, website_url, logo_url, is_active from organizations order by name`
    );
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      websiteUrl: r.website_url,
      logoUrl: r.logo_url,
      isActive: r.is_active,
    }));
  });
}

// ---------- organizational charts (migration 098) ----------

export interface HqGroup {
  ownerName: string;
  ownerTitle: string | null;
}

export interface OrgMemberRow {
  id: string;
  kind: "staff" | "manual" | "vacancy";
  employeeId: string | null;
  fullName: string | null;
  jobTitle: string | null;
  department: string | null;
  reportsTo: string | null;
}

/** Who owns every company; one row. */
export async function getHqGroup(): Promise<HqGroup> {
  return withAllTenants("business hq: the owner of the group", async () => {
    const { rows } = await getPool().query(`select owner_name, owner_title from hq_group where id`);
    return { ownerName: rows[0]?.owner_name ?? "Owner", ownerTitle: rows[0]?.owner_title ?? null };
  });
}

export async function listOrgMembers(organizationId: string): Promise<OrgMemberRow[]> {
  return withAllTenants("business hq: a company's chart rows", async () => {
    const { rows } = await getPool().query(
      `select id, kind, employee_id, full_name, job_title, department, reports_to
         from hq_org_members where organization_id = $1 order by created_at`,
      [organizationId]
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      employeeId: r.employee_id,
      fullName: r.full_name,
      jobTitle: r.job_title,
      department: r.department,
      reportsTo: r.reports_to,
    }));
  });
}

/**
 * Create or change a chart row. A 'staff' row is keyed by its employee, so
 * setting a Nexus person's manager twice updates one row.
 */
export async function upsertOrgMember(
  organizationId: string,
  input: Omit<OrgMemberRow, "id"> & { id?: string }
): Promise<OrgMemberRow | null> {
  return withAllTenants("business hq: save a chart row", async () => {
    const values = [input.kind, input.employeeId, input.fullName, input.jobTitle, input.department, input.reportsTo];
    const { rows } = input.id
      ? await getPool().query(
          `update hq_org_members
              set kind = $3, employee_id = $4, full_name = $5, job_title = $6, department = $7, reports_to = $8, updated_at = now()
            where id = $1 and organization_id = $2
            returning id, kind, employee_id, full_name, job_title, department, reports_to`,
          [input.id, organizationId, ...values]
        )
      : input.kind === "staff"
        ? await getPool().query(
            `insert into hq_org_members (organization_id, kind, employee_id, full_name, job_title, department, reports_to)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (organization_id, employee_id) where employee_id is not null
             do update set department = excluded.department, reports_to = excluded.reports_to, updated_at = now()
             returning id, kind, employee_id, full_name, job_title, department, reports_to`,
            [organizationId, ...values]
          )
        : await getPool().query(
            `insert into hq_org_members (organization_id, kind, employee_id, full_name, job_title, department, reports_to)
             values ($1, $2, $3, $4, $5, $6, $7)
             returning id, kind, employee_id, full_name, job_title, department, reports_to`,
            [organizationId, ...values]
          );
    const r = rows[0];
    return r
      ? { id: r.id, kind: r.kind, employeeId: r.employee_id, fullName: r.full_name, jobTitle: r.job_title, department: r.department, reportsTo: r.reports_to }
      : null;
  });
}

/** Remove a person added by hand or a vacancy; anyone who reported to them climbs a level. */
export async function deleteOrgMember(organizationId: string, id: string): Promise<boolean> {
  return withAllTenants("business hq: remove a chart row", async () => {
    const { rows } = await getPool().query(`select reports_to from hq_org_members where id = $1 and organization_id = $2 and kind <> 'staff'`, [id, organizationId]);
    if (!rows[0]) return false;
    await getPool().query(
      `update hq_org_members set reports_to = $3, updated_at = now() where organization_id = $1 and reports_to = $2`,
      [organizationId, `m:${id}`, rows[0].reports_to ?? "owner"]
    );
    await getPool().query(`delete from hq_org_members where id = $1 and organization_id = $2`, [id, organizationId]);
    return true;
  });
}
