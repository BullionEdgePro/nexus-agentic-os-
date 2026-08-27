import { getPool } from "./client.js";

/**
 * Admin accounts — named people with full cross-tenant access.
 *
 * Distinct from `employees`, who belong to exactly one business and sign in
 * with an issued access code. An admin sees every tenant, so the account is
 * identified and revocable individually rather than being a shared passphrase.
 */
export interface AdminAccount {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
  isActive: boolean;
  lastLoginAt: string | null;
  lastLoginDevice: string | null;
  avatarUrl: string | null;
  whatsappNumber: string | null;
}

interface AdminRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
  last_login_at: string | null;
  last_login_device: string | null;
  avatar_url: string | null;
  whatsapp_number: string | null;
}

const toAdmin = (row: AdminRow): AdminAccount => ({
  id: row.id,
  email: row.email,
  fullName: row.full_name,
  passwordHash: row.password_hash,
  isActive: row.is_active,
  lastLoginAt: row.last_login_at,
  lastLoginDevice: row.last_login_device,
  avatarUrl: row.avatar_url,
  whatsappNumber: row.whatsapp_number,
});

/**
 * Look up an admin for sign-in.
 *
 * Case-insensitive, matching the unique index — nobody types their own address
 * the same way twice. Only active accounts, so deactivating someone revokes
 * their access in that single write rather than depending on a second step.
 *
 * Returns the hash for the caller to verify, keeping the comparison in one
 * constant-time place (`verifySecret`) instead of handing a secret to the
 * database layer.
 */
export async function findAdminByEmail(email: string): Promise<AdminAccount | null> {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;

  const { rows } = await getPool().query<AdminRow>(
    `select id, email, full_name, password_hash, is_active, last_login_at, last_login_device, avatar_url, whatsapp_number
       from admins
      where lower(email) = $1 and is_active = true
      limit 1`,
    [needle]
  );
  return rows[0] ? toAdmin(rows[0]) : null;
}

/**
 * Create an admin, or reset an existing one's password.
 *
 * Upserts on the email so re-running the create script is how a forgotten
 * password is recovered — there is no reset flow and no recovery channel to
 * protect, which is the right shape for a handful of accounts on an internal
 * platform.
 */
export async function upsertAdmin(input: {
  email: string;
  fullName: string;
  passwordHash: string;
}): Promise<AdminAccount> {
  const { rows } = await getPool().query<AdminRow>(
    `insert into admins (email, full_name, password_hash)
     values ($1, $2, $3)
     on conflict (lower(email)) do update set
       full_name     = excluded.full_name,
       password_hash = excluded.password_hash,
       is_active     = true,
       updated_at    = now()
     returning id, email, full_name, password_hash, is_active, last_login_at, last_login_device, avatar_url, whatsapp_number`,
    [input.email.trim(), input.fullName.trim(), input.passwordHash]
  );
  return toAdmin(rows[0]);
}

/** Look up an admin by the id carried in their session. */
export async function findAdminById(id: string): Promise<AdminAccount | null> {
  const { rows } = await getPool().query<AdminRow>(
    `select id, email, full_name, password_hash, is_active, last_login_at, last_login_device, avatar_url, whatsapp_number
       from admins
      where id = $1 and is_active = true
      limit 1`,
    [id]
  );
  return rows[0] ? toAdmin(rows[0]) : null;
}

/**
 * An operator editing their own name and picture.
 *
 * Email is not here on purpose: it is how they sign in, and this platform has
 * no password reset, so one mistyped character locks somebody out of the
 * console with no way back. Another admin reissues it with create-admin.
 */
export async function updateAdminProfile(
  id: string,
  input: { fullName?: string; avatarUrl?: string | null; whatsappNumber?: string | null }
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update admins
        set full_name       = coalesce($2, full_name),
            avatar_url      = case when $3::boolean then $4 else avatar_url end,
            whatsapp_number = case when $5::boolean then $6 else whatsapp_number end,
            updated_at      = now()
      where id = $1 and is_active = true`,
    [
      id,
      input.fullName ?? null,
      input.avatarUrl !== undefined,
      input.avatarUrl ?? null,
      input.whatsappNumber !== undefined,
      input.whatsappNumber ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function recordAdminLogin(adminId: string, device?: string | null): Promise<void> {
  // See the note in recordEmployeeLogin: a sign-in with no usable device header
  // must not erase the last device that was recognised.
  await getPool().query(
    `update admins
        set last_login_at = now(),
            last_login_device = coalesce(nullif($2, ''), last_login_device)
      where id = $1`,
    [adminId, device ?? null]
  );
}

/**
 * Has anyone actually signed in with a named admin account?
 *
 * This is the retirement condition for the shared operator password, and it is
 * deliberately the same sentence the login route has carried as a comment since
 * admin accounts were added: the shared password "should be removed once a real
 * admin account has been created and used."
 *
 * It was stated and never enforced, so any email plus the default `demo1234`
 * has been granting full cross-tenant access to five businesses' customer
 * conversations for as long as admin accounts have existed.
 *
 * WHY "USED" AND NOT MERELY "EXISTS". Creating an account proves someone ran a
 * script. Signing in with it proves the credential actually works and somebody
 * holds it. Retiring the shared password on existence alone would lock the
 * platform's owner out of their own console the moment a create script ran with
 * a password they then mistyped or lost — turning a security fix into an
 * outage. `last_login_at` is the only evidence that another door is genuinely
 * open before this one is shut.
 *
 * Counted across ALL admins, and only active ones: deactivating the single
 * admin who had signed in correctly re-opens the bootstrap path, because at
 * that point there is again no working named account.
 */
export async function hasWorkingAdminAccount(): Promise<boolean> {
  const { rows } = await getPool().query<{ n: string }>(
    `select count(*)::text as n
       from admins
      where is_active = true and last_login_at is not null`
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function listAdmins(): Promise<Array<Omit<AdminAccount, "passwordHash">>> {
  const { rows } = await getPool().query<AdminRow>(
    `select id, email, full_name, '' as password_hash, is_active, last_login_at, last_login_device, avatar_url, whatsapp_number
       from admins order by created_at asc`
  );
  return rows.map(({ password_hash: _ignored, ...row }) => {
    const admin = toAdmin({ ...row, password_hash: "" });
    const { passwordHash: _drop, ...safe } = admin;
    return safe;
  });
}

/** Revoke one admin without deleting the row, so their history stays attributed. */
export async function deactivateAdmin(adminId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update admins set is_active = false, updated_at = now() where id = $1 and is_active = true`,
    [adminId]
  );
  return (rowCount ?? 0) > 0;
}
