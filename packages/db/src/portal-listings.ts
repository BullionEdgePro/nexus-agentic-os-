import { randomBytes } from "node:crypto";
import {
  portalProblems,
  portalProblemSentence,
  toPortalListing,
  type BoardUnit,
  type PortalListing,
  type PortalTarget,
} from "@nexus/shared";
import { getPool, withAllTenants, withTenant } from "./client.js";
import { unitsWhere, type Actor, type Viewer } from "./workflow-board.js";

/**
 * Portal listings (7 Nov 2026): a unit's photos, its publish switches, the
 * business's ORN and feed address, each agent's BRN, and what the portals are
 * given.
 *
 * WHAT IS PUBLISHED IS DECIDED WHEN IT IS READ: a unit is in a portal's output
 * only while it is wanted there AND ready (portalProblems, @nexus/shared). A
 * permit that expires overnight or a card that closes leaves the portals with
 * no job and no stale flag, and comes back when fixed if still wanted.
 *
 * Two lookups have no business to start from — the feed, which arrives with a
 * token, and a public photo, which arrives with its id. Each looks across
 * businesses for that one row and then works inside the business it found.
 *
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §3, §5, §6
 */

export const MAX_PHOTOS = 30;
const TOO_MANY = "A unit has at most 30 photos.";
const BAD_ORDER = "The order must list each of this unit's photos once.";

type Refused = { refused: string };
const actorIds = (actor: Actor): [string | null, string | null] =>
  "employeeId" in actor ? [actor.employeeId, null] : [null, actor.adminId];
const EVERYONE: Viewer = { employeeId: null, seesAll: true };

/** The open unit, locked for a change to its photos; null when there is none or it is closed. */
async function lockOpenUnit(organizationId: string, unitId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `select 1 from property_units where organization_id = $1 and id = $2 and closed_at is null for update`,
    [organizationId, unitId]
  );
  return (rowCount ?? 0) > 0;
}

/** Adds a photo at the end. null: no such open unit. */
export async function addUnitPhoto(
  organizationId: string,
  unitId: string,
  photo: { bytes: Uint8Array; width: number; height: number },
  actor: Actor
): Promise<{ id: string } | Refused | null> {
  return withTenant(organizationId, async () => {
    if (!(await lockOpenUnit(organizationId, unitId))) return null;
    const { rows: count } = await getPool().query<{ n: number }>(`select count(*)::int as n from unit_photos where unit_id = $1`, [unitId]);
    if (count[0].n >= MAX_PHOTOS) return { refused: TOO_MANY };
    const [employeeId, adminId] = actorIds(actor);
    const { rows } = await getPool().query<{ id: string }>(
      `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size, uploaded_by_employee_id, uploaded_by_admin_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [organizationId, unitId, count[0].n, Buffer.from(photo.bytes), photo.width, photo.height, photo.bytes.byteLength, employeeId, adminId]
    );
    return { id: String(rows[0].id) };
  });
}

/** A photo's bytes for the signed-in board; null when it is not this unit's. */
export async function unitPhotoBytes(organizationId: string, unitId: string, photoId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ bytes: Buffer }>(
      `select bytes from unit_photos where organization_id = $1 and unit_id = $2 and id = $3`,
      [organizationId, unitId, photoId]
    );
    return rows[0] ? new Uint8Array(rows[0].bytes) : null;
  });
}

/** Puts the photos in this order; every photo exactly once, or nothing changes. */
export async function orderUnitPhotos(organizationId: string, unitId: string, ids: string[]): Promise<true | Refused | null> {
  return withTenant(organizationId, async () => {
    if (!(await lockOpenUnit(organizationId, unitId))) return null;
    const { rows } = await getPool().query<{ id: string }>(`select id from unit_photos where unit_id = $1`, [unitId]);
    const have = new Set(rows.map((r) => String(r.id)));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((x) => have.has(x))) return { refused: BAD_ORDER };
    // The (unit, position) rule is checked at commit, so the swap may pass through clashes.
    await getPool().query(
      `update unit_photos p set position = (o.ord - 1)::int
         from unnest($2::uuid[]) with ordinality as o(id, ord)
        where p.unit_id = $1 and p.id = o.id`,
      [unitId, ids]
    );
    return true;
  });
}

/** Removes a photo and closes the gap it leaves. */
export async function removeUnitPhoto(organizationId: string, unitId: string, photoId: string): Promise<boolean> {
  return withTenant(organizationId, async () => {
    if (!(await lockOpenUnit(organizationId, unitId))) return false;
    const { rowCount } = await getPool().query(`delete from unit_photos where unit_id = $1 and id = $2`, [unitId, photoId]);
    if (!rowCount) return false;
    await getPool().query(
      `update unit_photos p set position = r.n
         from (select id, (row_number() over (order by position) - 1)::int as n from unit_photos where unit_id = $1) r
        where p.id = r.id and p.position <> r.n`,
      [unitId]
    );
    return true;
  });
}

/** The ORN, the agent's BRN and the photo count: what the rule needs beside the card. */
async function listingContext(organizationId: string, unit: BoardUnit, today: string, closed: boolean) {
  const { rows: s } = await getPool().query<{ orn: string | null }>(`select orn from portal_settings where organization_id = $1`, [organizationId]);
  const { rows: a } = unit.agent
    ? await getPool().query<{ brn: string | null }>(`select brn from employees where organization_id = $1 and id = $2`, [organizationId, unit.agent.id])
    : { rows: [] as { brn: string | null }[] };
  return { today, orn: s[0]?.orn ?? null, agentBrn: a[0]?.brn ?? null, photoCount: unit.photos.length, closed };
}

/**
 * Turns a portal on or off for a unit. On is refused, in the rule's words,
 * unless the unit is ready; off is always allowed. "closed" for a closed card.
 */
export async function setUnitPortal(
  organizationId: string,
  unitId: string,
  portal: PortalTarget,
  wanted: boolean,
  actor: Actor,
  viewer: Viewer,
  today: string
): Promise<BoardUnit | Refused | "closed" | null> {
  return withTenant(organizationId, async () => {
    const [current] = await unitsWhere(organizationId, viewer, "u.id = $4", [unitId]);
    if (!current) return null;
    if (current.closed) return "closed";
    if (wanted) {
      const sentence = portalProblemSentence(portalProblems(current, await listingContext(organizationId, current, today, false)));
      if (sentence) return { refused: sentence };
    }
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `insert into unit_portals (organization_id, unit_id, portal, wanted, changed_by_employee_id, changed_by_admin_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (unit_id, portal) do update
         set wanted = excluded.wanted, changed_at = now(),
             changed_by_employee_id = excluded.changed_by_employee_id, changed_by_admin_id = excluded.changed_by_admin_id`,
      [organizationId, unitId, portal, wanted, employeeId, adminId]
    );
    const [after] = await unitsWhere(organizationId, viewer, "u.id = $4", [unitId]);
    const { closed: _closed, ...card } = after;
    return card;
  });
}

export type PortalSettings = { orn: string | null; feedToken: string | null; feedLastReadAt: string | null; feedLastReadBy: string | null };

export async function portalSettings(organizationId: string): Promise<PortalSettings> {
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ orn: string | null; feed_token: string | null; feed_last_read_at: Date | null; feed_last_read_by: string | null }>(
      `select orn, feed_token, feed_last_read_at, feed_last_read_by from portal_settings where organization_id = $1`,
      [organizationId]
    );
    const r = rows[0];
    return {
      orn: r?.orn ?? null,
      feedToken: r?.feed_token ?? null,
      feedLastReadAt: r?.feed_last_read_at ? new Date(r.feed_last_read_at).toISOString() : null,
      feedLastReadBy: r?.feed_last_read_by ?? null,
    };
  });
}

export async function setPortalOrn(organizationId: string, orn: string | null): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `insert into portal_settings (organization_id, orn) values ($1, $2)
       on conflict (organization_id) do update set orn = excluded.orn`,
      [organizationId, orn]
    );
  });
}

/** A new feed address; the old one stops working at once. */
export async function newPortalFeed(organizationId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  return withTenant(organizationId, async () => {
    await getPool().query(
      `insert into portal_settings (organization_id, feed_token, feed_created_at) values ($1, $2, now())
       on conflict (organization_id) do update
         set feed_token = excluded.feed_token, feed_created_at = now(), feed_last_read_at = null, feed_last_read_by = null`,
      [organizationId, token]
    );
    return token;
  });
}

/** The business a feed token belongs to: one lookup across businesses. */
export async function feedByToken(token: string): Promise<{ organizationId: string; timezone: string } | null> {
  return withAllTenants("portal feed: the token names its business", async () => {
    const { rows } = await getPool().query<{ organization_id: string; timezone: string }>(
      `select ps.organization_id, o.timezone from portal_settings ps join organizations o on o.id = ps.organization_id
        where ps.feed_token = $1 and o.is_active`,
      [token]
    );
    return rows[0] ? { organizationId: String(rows[0].organization_id), timezone: rows[0].timezone } : null;
  });
}

/**
 * The units published to these portals today: open, wanted on at least one of
 * `targets`, and ready. Newest change first. Nothing private leaves here.
 */
export async function publishedListings(
  organizationId: string,
  targets: PortalTarget[],
  today: string,
  photoUrl: (photoId: string) => string
): Promise<PortalListing[]> {
  return withTenant(organizationId, async () => {
    const units = await unitsWhere(
      organizationId,
      EVERYONE,
      `u.closed_at is null and exists (select 1 from unit_portals up where up.unit_id = u.id and up.wanted and up.portal = any($4::text[]))`,
      [targets],
      "u.updated_at desc"
    );
    if (units.length === 0) return [];
    const { rows: s } = await getPool().query<{ orn: string | null }>(`select orn from portal_settings where organization_id = $1`, [organizationId]);
    const orn = s[0]?.orn ?? null;
    const agentIds = [...new Set(units.map((u) => u.agent?.id).filter((x): x is string => !!x))];
    const { rows: agents } = await getPool().query<{ id: string; full_name: string; email: string | null; whatsapp_number: string | null; brn: string | null }>(
      `select id, full_name, email, whatsapp_number, brn from employees where organization_id = $1 and id = any($2::uuid[])`,
      [organizationId, agentIds]
    );
    const byId = new Map(agents.map((a) => [String(a.id), a]));
    const listings: PortalListing[] = [];
    for (const unit of units) {
      const agent = unit.agent ? byId.get(unit.agent.id) : undefined;
      const problems = portalProblems(unit, { today, orn, agentBrn: agent?.brn ?? null, photoCount: unit.photos.length });
      if (problems.length > 0 || !agent?.brn || !orn) continue;
      listings.push(
        toPortalListing(unit, {
          orn,
          agent: { name: agent.full_name, email: agent.email, phone: agent.whatsapp_number, brn: agent.brn },
          photoUrls: unit.photos.map((p) => photoUrl(p.id)),
          portals: targets.filter((t) => unit.portals[t].wanted),
        })
      );
    }
    return listings;
  });
}

/** Notes that the feed was read, and by whom (at most once a minute). */
export async function noteFeedRead(organizationId: string, userAgent: string): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update portal_settings set feed_last_read_at = now(), feed_last_read_by = left($2, 200)
        where organization_id = $1 and (feed_last_read_at is null or feed_last_read_at < now() - interval '1 minute')`,
      [organizationId, userAgent]
    );
  });
}

/**
 * A photo for the portals to fetch: only while its unit is open and wanted on
 * at least one portal. One lookup across businesses finds the business; the
 * bytes are read inside it.
 */
export async function publicPhoto(photoId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const found = await withAllTenants("portal photo: the id names its business", async () => {
    const { rows } = await getPool().query<{ organization_id: string }>(
      `select p.organization_id from unit_photos p join property_units u on u.id = p.unit_id
        where p.id = $1 and u.closed_at is null
          and exists (select 1 from unit_portals up where up.unit_id = u.id and up.wanted)`,
      [photoId]
    );
    return rows[0] ? String(rows[0].organization_id) : null;
  });
  if (!found) return null;
  return withTenant(found, async () => {
    const { rows } = await getPool().query<{ bytes: Buffer }>(`select bytes from unit_photos where id = $1`, [photoId]);
    return rows[0] ? new Uint8Array(rows[0].bytes) : null;
  });
}

/** An agent's broker licence; false when they are not this business's staff. */
export async function setEmployeeBrn(organizationId: string, employeeId: string, brn: string | null): Promise<boolean> {
  return withTenant(organizationId, async () => {
    const { rowCount } = await getPool().query(`update employees set brn = $3 where organization_id = $1 and id = $2`, [organizationId, employeeId, brn]);
    return (rowCount ?? 0) > 0;
  });
}
