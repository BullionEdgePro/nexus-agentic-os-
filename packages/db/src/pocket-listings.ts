import { randomBytes } from "node:crypto";
import { POCKET_SHARE_DAYS, portalProblems, portalProblemSentence, type PocketShare } from "@nexus/shared";
import { getPool, withTenant } from "./client.js";
import { listingContext } from "./portal-listings.js";
import { SEES_DEAL, unitsWhere, type Actor, type Viewer } from "./workflow-board.js";

/**
 * Pocket listings (7 Nov 2026): a unit the owner does not want advertised is
 * marked "pocket" — never on the portals — and shown privately, one link per
 * buyer or tenant on the board.
 *
 * A link is made only when the unit would be ready for the portals (the same
 * rule, permit included: Dubai's advertising rules do not say a private share is
 * exempt), only with a buyer this viewer can see (the own-book rule), only for
 * the unit's purpose. One active link per unit and buyer; asking again answers
 * the same one; an expired one is revoked and replaced.
 *
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §4, §8
 */

type Refused = { refused: string };
export type CreatedPocketShare = {
  share: PocketShare;
  token: string;
  created: boolean;
  recipient: { firstName: string | null; number: string | null };
  unit: { title: string; community: string; priceAed: number };
  agentFirstName: string | null;
};

const TURN_POCKET_ON = "Turn Pocket on first.";
const NOT_YOUR_BUYER = "That buyer is not on your board for this kind of unit.";

const actorIds = (actor: Actor): [string | null, string | null] =>
  "employeeId" in actor ? [actor.employeeId, null] : [null, actor.adminId];
const firstWord = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || null;
const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

/**
 * Pocket on: every portal switch of the unit goes off in the same transaction
 * (who did it recorded, as a switch change). Pocket off: every active link of
 * the unit is revoked. "closed" for a closed card, null for none.
 */
export async function setUnitPocket(
  organizationId: string,
  unitId: string,
  on: boolean,
  actor: Actor,
  viewer: Viewer
): Promise<Awaited<ReturnType<typeof unitsWhere>>[number] | "closed" | null> {
  return withTenant(organizationId, async () => {
    const [current] = await unitsWhere(organizationId, viewer, "u.id = $4", [unitId]);
    if (!current) return null;
    if (current.closed) return "closed";
    const [employeeId, adminId] = actorIds(actor);
    const { rowCount } = await getPool().query(
      `update property_units
          set pocket = $3,
              pocket_since = case when $3 then coalesce(case when pocket then pocket_since end, now()) else null end,
              updated_at = now(), updated_by_employee_id = $4, updated_by_admin_id = $5
        where organization_id = $1 and id = $2 and closed_at is null`,
      [organizationId, unitId, on, employeeId, adminId]
    );
    if ((rowCount ?? 0) === 0) return "closed";
    if (on) {
      await getPool().query(
        `update unit_portals set wanted = false, changed_at = now(), changed_by_employee_id = $3, changed_by_admin_id = $4
          where organization_id = $1 and unit_id = $2 and wanted`,
        [organizationId, unitId, employeeId, adminId]
      );
    } else {
      await getPool().query(
        `update unit_pocket_shares set revoked_at = now() where organization_id = $1 and unit_id = $2 and revoked_at is null`,
        [organizationId, unitId]
      );
    }
    const [after] = await unitsWhere(organizationId, viewer, "u.id = $4", [unitId]);
    const { closed: _closed, ...card } = after;
    return card as typeof after;
  });
}

/** One link as the board shows it, read back after it is made. */
async function shareById(organizationId: string, shareId: string): Promise<PocketShare> {
  const { rows } = await getPool().query<{
    id: string;
    deal_id: string;
    contact_name: string | null;
    shared_by: string | null;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    first_viewed_at: Date | null;
    last_viewed_at: Date | null;
    view_count: number;
    interested_at: Date | null;
    active: boolean;
  }>(
    `select s.id, s.deal_id, coalesce(ct.display_name, ct.external_id, ct.wa_id) as contact_name,
            coalesce(se.full_name, sa.full_name) as shared_by, s.created_at, s.expires_at, s.revoked_at,
            s.first_viewed_at, s.last_viewed_at, s.view_count, s.interested_at,
            (s.revoked_at is null and s.expires_at > now()) as active
       from unit_pocket_shares s
       join property_deals d on d.id = s.deal_id
       left join contacts ct on ct.id = d.contact_id
       left join employees se on se.id = s.created_by_employee_id
       left join admins sa on sa.id = s.created_by_admin_id
      where s.organization_id = $1 and s.id = $2`,
    [organizationId, shareId]
  );
  const r = rows[0];
  return {
    id: String(r.id),
    dealId: String(r.deal_id),
    contactName: r.contact_name,
    sharedBy: r.shared_by,
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at)!,
    revokedAt: iso(r.revoked_at),
    firstViewedAt: iso(r.first_viewed_at),
    lastViewedAt: iso(r.last_viewed_at),
    viewCount: Number(r.view_count),
    interestedAt: iso(r.interested_at),
    active: r.active,
  };
}

/**
 * A private link for one buyer. Refused, in words, when the unit is not a
 * pocket, not ready, or the buyer is not this viewer's or wants the other
 * purpose. "closed" for a closed card; null when the unit or the deal does not
 * exist. The unit row is locked, so two clicks make one link.
 */
export async function createPocketShare(
  organizationId: string,
  unitId: string,
  dealId: string,
  actor: Actor,
  viewer: Viewer,
  today: string
): Promise<CreatedPocketShare | Refused | "closed" | null> {
  return withTenant(organizationId, async () => {
    const [unit] = await unitsWhere(organizationId, viewer, "u.id = $4", [unitId]);
    if (!unit) return null;
    if (unit.closed) return "closed";
    await getPool().query(`select 1 from property_units where organization_id = $1 and id = $2 for update`, [organizationId, unitId]);
    if (!unit.pocket.on) return { refused: TURN_POCKET_ON };
    const sentence = portalProblemSentence(
      portalProblems(unit, await listingContext(organizationId, unit, today, false)),
      "Before it can be shared"
    );
    if (sentence) return { refused: sentence };

    const exists = await getPool().query(`select 1 from property_deals where organization_id = $1 and id = $2`, [organizationId, dealId]);
    if (exists.rowCount === 0) return null;
    const { rows: deals } = await getPool().query<{ purpose: string; closed_at: Date | null; display_name: string | null; wa_id: string | null }>(
      `select d.purpose, d.closed_at, ct.display_name, ct.wa_id
         from property_deals d left join contacts ct on ct.id = d.contact_id
        where d.organization_id = $1 and d.id = $4 and ${SEES_DEAL}`,
      [organizationId, viewer.seesAll, viewer.employeeId, dealId]
    );
    const deal = deals[0];
    if (!deal || deal.closed_at || deal.purpose !== unit.purpose) return { refused: NOT_YOUR_BUYER };

    const { rows: held } = await getPool().query<{ id: string; token: string; live: boolean }>(
      `select id, token, expires_at > now() as live from unit_pocket_shares
        where organization_id = $1 and unit_id = $2 and deal_id = $3 and revoked_at is null`,
      [organizationId, unitId, dealId]
    );
    let shareId: string;
    let token: string;
    let created: boolean;
    if (held[0]?.live) {
      ({ id: shareId, token } = held[0]);
      created = false;
    } else {
      if (held[0]) await getPool().query(`update unit_pocket_shares set revoked_at = now() where id = $1`, [held[0].id]);
      const [employeeId, adminId] = actorIds(actor);
      token = randomBytes(32).toString("base64url");
      const { rows } = await getPool().query<{ id: string }>(
        `insert into unit_pocket_shares (organization_id, unit_id, deal_id, token, created_by_employee_id, created_by_admin_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
         returning id`,
        [organizationId, unitId, dealId, token, employeeId, adminId, POCKET_SHARE_DAYS]
      );
      shareId = String(rows[0].id);
      created = true;
    }
    const number = deal.wa_id && /^\d{6,20}$/.test(deal.wa_id) ? deal.wa_id : null;
    return {
      share: await shareById(organizationId, shareId),
      token,
      created,
      recipient: { firstName: firstWord(deal.display_name), number },
      unit: { title: unit.title ?? "", community: unit.community ?? "", priceAed: unit.priceAed ?? 0 },
      agentFirstName: firstWord(unit.agent?.name),
    };
  });
}

/** Revokes one link of a unit; false when there is no such active link. */
export async function revokePocketShare(organizationId: string, unitId: string, shareId: string): Promise<boolean> {
  return withTenant(organizationId, async () => {
    const { rowCount } = await getPool().query(
      `update unit_pocket_shares set revoked_at = now()
        where organization_id = $1 and unit_id = $2 and id = $3 and revoked_at is null`,
      [organizationId, unitId, shareId]
    );
    return (rowCount ?? 0) > 0;
  });
}
