import { BAYUT_PORTALS, bayutProblems, type BayutPortal, type BayutRemote, type BayutState, type PortalListing } from "@nexus/shared";
import { getPool, withAllTenants, withTenant } from "./client.js";
import { publishedListings } from "./portal-listings.js";
import { openToken, sealToken } from "./token-crypto.js";
import { unitsWhere, type Viewer } from "./workflow-board.js";

/**
 * Bayut records (23 Nov 2026): the business's Bayut API token, kept sealed with
 * what the last check said and the Bayut agency it belongs to; each Nexus
 * agent's Bayut user; the units the Bayut sync looks at; and each answer Bayut
 * gives, written on the unit's Bayut or dubizzle row.
 *
 * The token is sealed here (AES-256-GCM, key outside the database) and only
 * opened by `bayutToken`, for the check, the location search and the sync.
 * Nothing else ever reads it back; the screen gets its last four characters.
 *
 * NEXUS MANAGES ONLY THE BAYUT LISTINGS IT CREATED, known by the Bayut id it got
 * back. A token for another Bayut agency turns every Bayut and dubizzle switch
 * off and forgets those ids: they mean nothing on the new account, and nothing
 * ticked during a Sandbox trial may go live on the real account by itself.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §1, §4, §5, §8, §9
 */

export type BayutConnectionView = {
  saved: boolean;
  agencyName: string | null;
  tokenEnding: string | null;
  checkedAt: string | null;
  checkError: string | null;
};

export type BayutAgentLink = { employeeId: string; bayutUserId: number; bayutUserName: string | null };

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const EVERYONE: Viewer = { employeeId: null, seesAll: true };

/**
 * Saves the token sealed, with what the check said and the agency it belongs
 * to; the ORN and feed are left alone. An agency the check could not read
 * (null) keeps the one held and changes nothing else. Another agency than the
 * one held turns every Bayut and dubizzle switch off, clears what Bayut said
 * on those rows, and removes the agent links (the old account's users).
 */
export async function saveBayutConnection(
  organizationId: string,
  input: { token: string; agencyId: number | null; agencyName: string | null; checkError: string | null }
): Promise<{ accountChanged: boolean }> {
  const sealed = sealToken(input.token);
  return withTenant(organizationId, async () => {
    const before = await getPool().query<{ bayut_agency_id: number | null }>(
      `select bayut_agency_id from portal_settings where organization_id = $1 for update`,
      [organizationId]
    );
    const previous = before.rows[0]?.bayut_agency_id ?? null;
    await getPool().query(
      `insert into portal_settings (organization_id, bayut_token_sealed, bayut_token_ending, bayut_agency_id, bayut_agency_name, bayut_checked_at, bayut_check_error)
       values ($1, $2, $3, $4, left($5, 200), now(), left($6, 400))
       on conflict (organization_id) do update
         set bayut_token_sealed = excluded.bayut_token_sealed, bayut_token_ending = excluded.bayut_token_ending,
             bayut_agency_id = coalesce(excluded.bayut_agency_id, portal_settings.bayut_agency_id),
             bayut_agency_name = case when excluded.bayut_agency_id is null then portal_settings.bayut_agency_name
                                      else excluded.bayut_agency_name end,
             bayut_checked_at = now(), bayut_check_error = excluded.bayut_check_error`,
      [organizationId, sealed, input.token.slice(-4), input.agencyId, input.agencyName, input.checkError]
    );
    const accountChanged = previous !== null && input.agencyId !== null && Number(previous) !== input.agencyId;
    if (accountChanged) {
      // Turned off by the system: no person changed these switches.
      await getPool().query(
        `update unit_portals
            set wanted = false,
                changed_at = case when wanted then now() else changed_at end,
                changed_by_employee_id = case when wanted then null else changed_by_employee_id end,
                changed_by_admin_id = case when wanted then null else changed_by_admin_id end,
                remote_ref = null, remote_state = null, remote_message = null, remote_fingerprint = null,
                published_at = null, permit_comment = null, synced_at = null
          where organization_id = $1 and portal in ('bayut', 'dubizzle')`,
        [organizationId]
      );
      await getPool().query(`delete from bayut_agents where organization_id = $1`, [organizationId]);
    }
    return { accountChanged };
  });
}

/** What the latest check of the saved token said (null: Bayut answered). */
export async function recordBayutCheck(organizationId: string, checkError: string | null): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update portal_settings set bayut_checked_at = now(), bayut_check_error = left($2, 400)
        where organization_id = $1 and bayut_token_sealed is not null`,
      [organizationId, checkError]
    );
  });
}

/**
 * Disconnect: the token and its check cleared, and the agent links removed;
 * listings already on Bayut stay there, and the unit rows keep their ids. The
 * agency is remembered, so coming back with another account's token still
 * turns the switches off.
 */
export async function clearBayutConnection(organizationId: string): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update portal_settings
          set bayut_token_sealed = null, bayut_token_ending = null, bayut_checked_at = null, bayut_check_error = null
        where organization_id = $1`,
      [organizationId]
    );
    await getPool().query(`delete from bayut_agents where organization_id = $1`, [organizationId]);
  });
}

/** What the screen may know: never the token. */
export async function bayutConnectionView(organizationId: string): Promise<BayutConnectionView> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{
      saved: boolean;
      bayut_agency_name: string | null;
      bayut_token_ending: string | null;
      bayut_checked_at: Date | null;
      bayut_check_error: string | null;
    }>(
      `select bayut_token_sealed is not null as saved, bayut_agency_name, bayut_token_ending, bayut_checked_at, bayut_check_error
         from portal_settings where organization_id = $1`,
      [organizationId]
    );
    const r = rows[0];
    if (!r?.saved) return { saved: false, agencyName: null, tokenEnding: null, checkedAt: null, checkError: null };
    return {
      saved: true,
      agencyName: r.bayut_agency_name,
      tokenEnding: r.bayut_token_ending,
      checkedAt: iso(r.bayut_checked_at),
      checkError: r.bayut_check_error,
    };
  });
}

/**
 * The token, opened, with its agency — for the check, the location search and
 * the sync only. Null only when none is saved or it cannot be opened; the agency
 * is null while no check has read it (a first check that failed), so the token
 * can still be checked again. The sync skips a null agency.
 */
export async function bayutToken(organizationId: string): Promise<{ token: string; agencyId: number | null } | null> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ bayut_token_sealed: string | null; bayut_agency_id: number | null }>(
      `select bayut_token_sealed, bayut_agency_id from portal_settings where organization_id = $1`,
      [organizationId]
    );
    const r = rows[0];
    const token = openToken(r?.bayut_token_sealed);
    if (!token) return null;
    return { token, agencyId: r?.bayut_agency_id === null || r?.bayut_agency_id === undefined ? null : Number(r.bayut_agency_id) };
  });
}

/** Active businesses whose token was checked and not refused: the ones the Bayut sync works for. */
export async function bayutBusinesses(): Promise<{ organizationId: string; timezone: string }[]> {
  return withAllTenants("bayut sync: which businesses have a working token", async () => {
    const { rows } = await getPool().query<{ organization_id: string; timezone: string }>(
      `select ps.organization_id, o.timezone
         from portal_settings ps join organizations o on o.id = ps.organization_id
        where o.is_active and ps.bayut_token_sealed is not null and ps.bayut_checked_at is not null and ps.bayut_check_error is null
        order by ps.organization_id`
    );
    return rows.map((r) => ({ organizationId: String(r.organization_id), timezone: r.timezone }));
  });
}

/** Each linked agent's Bayut user. */
export async function bayutAgentLinks(organizationId: string): Promise<BayutAgentLink[]> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ employee_id: string; bayut_user_id: number; bayut_user_name: string | null }>(
      `select employee_id, bayut_user_id, bayut_user_name from bayut_agents where organization_id = $1 order by linked_at, employee_id`,
      [organizationId]
    );
    return rows.map((r) => ({ employeeId: String(r.employee_id), bayutUserId: Number(r.bayut_user_id), bayutUserName: r.bayut_user_name }));
  });
}

/** An admin links an agent to a Bayut user, or (null) removes the link; false when they are not this business's staff. */
export async function linkBayutAgent(
  organizationId: string,
  employeeId: string,
  link: { bayutUserId: number; bayutUserName: string | null } | null
): Promise<boolean> {
  return withTenant(organizationId, async () => {
    const { rowCount } = await getPool().query(`select 1 from employees where organization_id = $1 and id = $2`, [organizationId, employeeId]);
    if (!rowCount) return false;
    if (link === null) {
      await getPool().query(`delete from bayut_agents where organization_id = $1 and employee_id = $2`, [organizationId, employeeId]);
      return true;
    }
    await getPool().query(
      `insert into bayut_agents (organization_id, employee_id, bayut_user_id, bayut_user_name)
       values ($1, $2, $3, left($4, 200))
       on conflict (organization_id, employee_id) do update
         set bayut_user_id = excluded.bayut_user_id, bayut_user_name = excluded.bayut_user_name, linked_at = now()`,
      [organizationId, employeeId, link.bayutUserId, link.bayutUserName]
    );
    return true;
  });
}

/**
 * After a good check: staff whose email is a Bayut user's (case-insensitive)
 * are linked to that user, where they have no link yet — a link an admin chose
 * is kept. How many were linked.
 */
export async function autoLinkBayutAgents(organizationId: string, users: { id: number; name: string; email: string | null }[]): Promise<number> {
  const withEmail = users.filter((u) => u.email && u.email.trim() !== "");
  if (withEmail.length === 0) return 0;
  return withTenant(organizationId, async () => {
    const { rowCount } = await getPool().query(
      `insert into bayut_agents (organization_id, employee_id, bayut_user_id, bayut_user_name)
       select distinct on (e.id) $1::uuid, e.id, u.id, left(u.name, 200)
         from employees e
         join unnest($2::int[], $3::text[], $4::text[]) with ordinality as u(id, name, email, ord)
           on lower(trim(e.email)) = lower(trim(u.email))
        where e.organization_id = $1
          and not exists (select 1 from bayut_agents ba where ba.organization_id = $1 and ba.employee_id = e.id)
        order by e.id, u.ord
       on conflict (organization_id, employee_id) do nothing`,
      [organizationId, withEmail.map((u) => u.id), withEmail.map((u) => u.name), withEmail.map((u) => u.email)]
    );
    return rowCount ?? 0;
  });
}

/**
 * What goes to Bayut today: the units published to Bayut or dubizzle (open,
 * wanted, ready by the portals' rule) that Bayut's rule also passes — a Bayut
 * location and the agent linked to a Bayut user — with the portals wanted.
 */
export async function bayutListings(
  organizationId: string,
  today: string,
  photoUrl: (photoId: string) => string
): Promise<{ listing: PortalListing; portals: BayutPortal[]; userId: number; locationId: number }[]> {
  return withTenant(organizationId, async () => {
    const listings = await publishedListings(organizationId, [...BAYUT_PORTALS], today, photoUrl);
    if (listings.length === 0) return [];
    const units = await unitsWhere(organizationId, EVERYONE, "u.id = any($4::uuid[])", [listings.map((l) => l.reference)]);
    const byId = new Map(units.map((u) => [u.id, u]));
    const { rows: links } = await getPool().query<{ employee_id: string; bayut_user_id: number }>(
      `select employee_id, bayut_user_id from bayut_agents where organization_id = $1`,
      [organizationId]
    );
    const userOf = new Map(links.map((l) => [String(l.employee_id), Number(l.bayut_user_id)]));
    const out: { listing: PortalListing; portals: BayutPortal[]; userId: number; locationId: number }[] = [];
    for (const listing of listings) {
      const unit = byId.get(listing.reference);
      if (!unit) continue;
      const userId = unit.agent ? (userOf.get(unit.agent.id) ?? null) : null;
      const locationId = unit.bayutLocation?.id ?? null;
      // The sync runs only with a token, so the agent's link is always asked for here.
      if (bayutProblems(unit, { tokenSaved: true, locationId, userId }).length > 0 || userId === null || locationId === null) continue;
      out.push({ listing, portals: BAYUT_PORTALS.filter((p) => listing.portals.includes(p)), userId, locationId });
    }
    return out;
  });
}

type RemoteRow = {
  unit_id: string;
  b_ref: string | null;
  b_fingerprint: string | null;
  b_state: BayutState | null;
  b_published_at: Date | null;
  d_ref: string | null;
  d_fingerprint: string | null;
  d_state: BayutState | null;
  d_published_at: Date | null;
};

/**
 * The units the Bayut sync looks at: wanted on Bayut or dubizzle, or possibly
 * still held there — a ref whose state is not `unpublished`, a draft or a
 * pending publish included — closed units too, so a closed unit comes off.
 * Never-sent first, then the longest since Bayut's last answer.
 */
export async function bayutUnitsToSync(organizationId: string): Promise<{ unitId: string; remote: BayutRemote }[]> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<RemoteRow>(
      `select u.id as unit_id,
              b.remote_ref as b_ref, b.remote_fingerprint as b_fingerprint, b.remote_state as b_state, b.published_at as b_published_at,
              d.remote_ref as d_ref, d.remote_fingerprint as d_fingerprint, d.remote_state as d_state, d.published_at as d_published_at
         from property_units u
         left join unit_portals b on b.unit_id = u.id and b.portal = 'bayut'
         left join unit_portals d on d.unit_id = u.id and d.portal = 'dubizzle'
        where u.organization_id = $1
          and exists (select 1 from unit_portals up
                       where up.unit_id = u.id and up.portal in ('bayut', 'dubizzle')
                         and (up.wanted or (up.remote_ref is not null and up.remote_state is distinct from 'unpublished')))
        order by least(b.synced_at, d.synced_at) asc nulls first, u.id`,
      [organizationId]
    );
    return rows.map((r) => ({
      unitId: String(r.unit_id),
      remote: {
        // One Bayut listing serves both portals: the same ref on both rows.
        ref: r.b_ref ?? r.d_ref,
        fingerprint: r.b_fingerprint ?? r.d_fingerprint,
        portals: {
          bayut: { state: r.b_state, publishedAt: iso(r.b_published_at) },
          dubizzle: { state: r.d_state, publishedAt: iso(r.d_published_at) },
        },
      },
    }));
  });
}

/**
 * Bayut's answer for one portal of one unit. The switch is never touched; a
 * ref, fingerprint, publish time or permit comment not given keeps the one
 * held (a null permit comment clears it); a unit with no row for that portal
 * gets one, switched off.
 */
export async function recordBayutStep(
  organizationId: string,
  unitId: string,
  portal: BayutPortal,
  r: { ref?: string; state: BayutState; message: string | null; fingerprint?: string; publishedAt?: Date; permitComment?: string | null }
): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `insert into unit_portals (organization_id, unit_id, portal, wanted, remote_ref, remote_state, remote_message, remote_fingerprint,
                                 published_at, permit_comment, synced_at)
       values ($1, $2, $3, false, $4, $5, $6, $7, $8, left($9, 300), now())
       on conflict (unit_id, portal) do update
         set remote_ref = coalesce(excluded.remote_ref, unit_portals.remote_ref),
             remote_state = excluded.remote_state,
             remote_message = excluded.remote_message,
             remote_fingerprint = coalesce(excluded.remote_fingerprint, unit_portals.remote_fingerprint),
             published_at = coalesce(excluded.published_at, unit_portals.published_at),
             permit_comment = case when $10 then excluded.permit_comment else unit_portals.permit_comment end,
             synced_at = now()`,
      [
        organizationId,
        unitId,
        portal,
        r.ref ?? null,
        r.state,
        r.message,
        r.fingerprint ?? null,
        r.publishedAt ?? null,
        r.permitComment ?? null,
        r.permitComment !== undefined,
      ]
    );
  });
}

/**
 * Bayut took a portal down that Nexus held live or pending and still wanted
 * (it expired, Bayut removed it, or someone did in Profolio): the switch goes
 * off, changed by the system, with the date. Nexus never republishes on its
 * own — staff tick it again to spend the credits. `on` is the business's date,
 * as the caller shows it (e.g. "21 Nov").
 */
export async function bayutTakenOff(organizationId: string, unitId: string, portal: BayutPortal, on: string): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update unit_portals
          set wanted = false, changed_by_employee_id = null, changed_by_admin_id = null, changed_at = now(),
              remote_state = 'unpublished', remote_message = $4, synced_at = now()
        where organization_id = $1 and unit_id = $2 and portal = $3`,
      [organizationId, unitId, portal, `Bayut took it off on ${on}`]
    );
  });
}
