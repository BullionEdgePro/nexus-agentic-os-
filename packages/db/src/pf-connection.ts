import type { PfRemote, PfState } from "@nexus/shared";
import { getPool, withAllTenants, withTenant } from "./client.js";
import { openToken, sealToken } from "./token-crypto.js";

/**
 * Property Finder records (7 Nov 2026): the business's API key and secret, kept
 * sealed with what the last check said; the units the sync looks at; and each
 * answer Property Finder gives, written on the unit's Property Finder row.
 *
 * The key and secret are sealed here (AES-256-GCM, key outside the database) and
 * only opened by `pfCredentials`, which the sync and the check use. Nothing
 * else ever reads them back; the screen gets the key's last four characters.
 *
 * Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §3, §5
 */

export type PfEnvironment = "sandbox" | "live";
export type PfConnectionView = {
  saved: boolean;
  environment: PfEnvironment | null;
  keyEnding: string | null;
  checkedAt: string | null;
  checkError: string | null;
};

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** Saves the key and secret sealed, with what the check said; the ORN and feed are left alone. */
export async function savePfConnection(
  organizationId: string,
  input: { key: string; secret: string; environment: PfEnvironment; checkError: string | null }
): Promise<void> {
  const keySealed = sealToken(input.key);
  const secretSealed = sealToken(input.secret);
  return withTenant(organizationId, async () => {
    await getPool().query(
      `insert into portal_settings (organization_id, pf_key_sealed, pf_secret_sealed, pf_key_ending, pf_environment, pf_checked_at, pf_check_error)
       values ($1, $2, $3, $4, $5, now(), $6)
       on conflict (organization_id) do update
         set pf_key_sealed = excluded.pf_key_sealed, pf_secret_sealed = excluded.pf_secret_sealed,
             pf_key_ending = excluded.pf_key_ending, pf_environment = excluded.pf_environment,
             pf_checked_at = now(), pf_check_error = excluded.pf_check_error`,
      [organizationId, keySealed, secretSealed, input.key.slice(-4), input.environment, input.checkError]
    );
  });
}

/** What the latest check of the saved key said (null: the token came back). */
export async function recordPfCheck(organizationId: string, checkError: string | null): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update portal_settings set pf_checked_at = now(), pf_check_error = $2
        where organization_id = $1 and pf_key_sealed is not null`,
      [organizationId, checkError]
    );
  });
}

/** Disconnect: the six Property Finder columns cleared; units already on Property Finder stay there. */
export async function clearPfConnection(organizationId: string): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update portal_settings
          set pf_key_sealed = null, pf_secret_sealed = null, pf_key_ending = null,
              pf_environment = null, pf_checked_at = null, pf_check_error = null
        where organization_id = $1`,
      [organizationId]
    );
  });
}

/** What the screen may know: never the key or the secret. */
export async function pfConnectionView(organizationId: string): Promise<PfConnectionView> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{
      saved: boolean;
      pf_environment: PfEnvironment | null;
      pf_key_ending: string | null;
      pf_checked_at: Date | null;
      pf_check_error: string | null;
    }>(
      `select pf_key_sealed is not null as saved, pf_environment, pf_key_ending, pf_checked_at, pf_check_error
         from portal_settings where organization_id = $1`,
      [organizationId]
    );
    const r = rows[0];
    if (!r?.saved) return { saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null };
    return {
      saved: true,
      environment: r.pf_environment,
      keyEnding: r.pf_key_ending,
      checkedAt: iso(r.pf_checked_at),
      checkError: r.pf_check_error,
    };
  });
}

/** The key and secret, opened — for the check and the sync only. Null when none is saved or it cannot be opened. */
export async function pfCredentials(organizationId: string): Promise<{ key: string; secret: string; environment: PfEnvironment } | null> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ pf_key_sealed: string | null; pf_secret_sealed: string | null; pf_environment: PfEnvironment | null }>(
      `select pf_key_sealed, pf_secret_sealed, pf_environment from portal_settings where organization_id = $1`,
      [organizationId]
    );
    const r = rows[0];
    const key = openToken(r?.pf_key_sealed);
    const secret = openToken(r?.pf_secret_sealed);
    if (!key || !secret || !r?.pf_environment) return null;
    return { key, secret, environment: r.pf_environment };
  });
}

/** Active businesses whose key was checked and not refused: the ones the sync works for. */
export async function pfBusinesses(): Promise<{ organizationId: string; timezone: string }[]> {
  return withAllTenants("property finder sync: which businesses have a working key", async () => {
    const { rows } = await getPool().query<{ organization_id: string; timezone: string }>(
      `select ps.organization_id, o.timezone
         from portal_settings ps join organizations o on o.id = ps.organization_id
        where o.is_active and ps.pf_key_sealed is not null and ps.pf_checked_at is not null and ps.pf_check_error is null
        order by ps.organization_id`
    );
    return rows.map((r) => ({ organizationId: String(r.organization_id), timezone: r.timezone }));
  });
}

/**
 * The units the sync looks at: wanted on Property Finder, or still live there —
 * closed units included, so a closed unit comes off. Never-sent first, then the
 * longest since its last answer.
 */
export async function pfUnitsToSync(organizationId: string, limit: number): Promise<{ unitId: string; remote: PfRemote }[]> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ unit_id: string; remote_ref: string | null; remote_state: PfState | null; remote_fingerprint: string | null }>(
      `select up.unit_id, up.remote_ref, up.remote_state, up.remote_fingerprint
         from unit_portals up
        where up.organization_id = $1 and up.portal = 'property_finder'
          and (up.wanted or up.remote_state = 'live')
        order by up.synced_at asc nulls first, up.unit_id
        limit $2`,
      [organizationId, limit]
    );
    return rows.map((r) => ({
      unitId: String(r.unit_id),
      remote: { ref: r.remote_ref, state: r.remote_state, fingerprint: r.remote_fingerprint },
    }));
  });
}

/**
 * Property Finder's answer for one unit. The switch is never touched; a ref or
 * fingerprint not given keeps the one held; a unit with no Property Finder row
 * gets one, switched off.
 */
export async function recordPfStep(
  organizationId: string,
  unitId: string,
  r: { ref?: string; state: PfState; message: string | null; fingerprint?: string }
): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state, remote_message, remote_fingerprint, synced_at)
       values ($1, $2, 'property_finder', false, $3, $4, $5, $6, now())
       on conflict (unit_id, portal) do update
         set remote_ref = coalesce(excluded.remote_ref, unit_portals.remote_ref),
             remote_state = excluded.remote_state,
             remote_message = excluded.remote_message,
             remote_fingerprint = coalesce(excluded.remote_fingerprint, unit_portals.remote_fingerprint),
             synced_at = now()`,
      [organizationId, unitId, r.ref ?? null, r.state, r.message, r.fingerprint ?? null]
    );
  });
}
