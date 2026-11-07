import { randomBytes } from "node:crypto";
import { POCKET_SHARE_DAYS, portalProblems, portalProblemSentence, type PocketShare } from "@nexus/shared";
import { getPool, withAllTenants, withTenant } from "./client.js";
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

// ---------------------------------------------------------------------------
// The private page (no sign-in). A token is looked up across businesses once;
// everything after runs as the business it names. Every rule is checked on
// every read, so a link stops working the moment one stops holding.
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §1, §5, §6
// ---------------------------------------------------------------------------

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EVERYONE: Viewer = { employeeId: null, seesAll: true };
const VIEW_EVERY_MINUTES = 10;

/** What the private page shows — never the building, the reference, the owner, the notes. */
export type PocketView = {
  businessName: string;
  recipientFirstName: string | null;
  title: string;
  description: string;
  purpose: "rent" | "sale";
  priceAed: number;
  propertyType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  sizeSqft: number;
  furnishing: string | null;
  community: string;
  subCommunity: string | null;
  amenities: string[];
  availableFrom: string | null;
  photoIds: string[];
  /** The listing agent: the advert names them and their BRN. */
  agent: { name: string; firstName: string; brn: string; whatsapp: string | null };
  /** The buyer's own agent (final review): who they talk to, and who hears of their interest. */
  contact: { name: string; firstName: string; whatsapp: string | null };
  orn: string;
  permitNumber: string;
  expiresAt: string;
};
type Found = { organizationId: string; shareId: string; unitId: string; contactId: string | null; view: PocketView };

/** A WhatsApp number's digits — Meta stores "+971 58 848 3731" (final review); null for anything else. */
function waDigits(number: string | null | undefined): string | null {
  if (!number || /[a-z]/i.test(number)) return null;
  const digits = number.replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 20 ? digits : null;
}

const todayIn = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

async function findShare(token: string): Promise<Found | null> {
  if (!TOKEN.test(token)) return null;
  const share = await withAllTenants("pocket listing: the token names its business", async () => {
    const { rows } = await getPool().query<{
      id: string;
      organization_id: string;
      unit_id: string;
      deal_id: string;
      created_by_employee_id: string | null;
      expires_at: Date;
      name: string;
      timezone: string;
    }>(
      `select s.id, s.organization_id, s.unit_id, s.deal_id, s.created_by_employee_id, s.expires_at, o.name, o.timezone
         from unit_pocket_shares s join organizations o on o.id = s.organization_id
        where s.token = $1 and s.revoked_at is null and s.expires_at > now() and o.is_active`,
      [token]
    );
    return rows[0] ?? null;
  });
  if (!share) return null;
  const organizationId = String(share.organization_id);
  return withTenant(organizationId, async () => {
    const [unit] = await unitsWhere(organizationId, EVERYONE, "u.id = $4", [String(share.unit_id)]);
    if (!unit || unit.closed || !unit.pocket.on) return null;
    const ctx = await listingContext(organizationId, unit, todayIn(share.timezone), false);
    if (portalProblems(unit, ctx).length > 0) return null;
    const { rows: agents } = await getPool().query<{ full_name: string; brn: string | null; whatsapp_number: string | null }>(
      `select full_name, brn, whatsapp_number from employees where organization_id = $1 and id = $2`,
      [organizationId, unit.agent!.id]
    );
    // The buyer's own agent: whoever works the deal, else whoever holds the client
    // in their book, else whoever shared it, else the listing agent (final review).
    const { rows: deals } = await getPool().query<{
      display_name: string | null;
      contact_id: string | null;
      contact_name: string | null;
      contact_whatsapp: string | null;
    }>(
      `select ct.display_name, e.id as contact_id, e.full_name as contact_name, e.whatsapp_number as contact_whatsapp
         from property_deals d
         left join contacts ct on ct.id = d.contact_id
         left join employees e on e.organization_id = $1 and e.is_active
                              and e.id = coalesce(d.agent_employee_id, ct.owner_employee_id, $3::uuid, $4::uuid)
        where d.organization_id = $1 and d.id = $2`,
      [organizationId, String(share.deal_id), share.created_by_employee_id ?? null, unit.agent!.id]
    );
    const agent = agents[0];
    if (!agent?.brn || !ctx.orn) return null;
    const buyersAgent = deals[0]?.contact_id
      ? { id: String(deals[0].contact_id), name: deals[0].contact_name!, whatsapp: deals[0].contact_whatsapp }
      : { id: unit.agent!.id, name: agent.full_name, whatsapp: agent.whatsapp_number };
    return {
      organizationId,
      shareId: String(share.id),
      unitId: unit.id,
      contactId: buyersAgent.id,
      view: {
        businessName: share.name,
        recipientFirstName: firstWord(deals[0]?.display_name),
        title: unit.title!,
        description: unit.description!,
        purpose: unit.purpose!,
        priceAed: unit.priceAed!,
        propertyType: unit.propertyType!,
        bedrooms: unit.bedrooms,
        bathrooms: unit.bathrooms,
        sizeSqft: unit.sizeSqft!,
        furnishing: unit.furnishing,
        community: unit.community!,
        subCommunity: unit.subCommunity,
        amenities: unit.amenities,
        availableFrom: unit.availableFrom,
        photoIds: unit.photos.map((p) => p.id),
        agent: {
          name: agent.full_name,
          firstName: firstWord(agent.full_name) ?? agent.full_name,
          brn: agent.brn,
          whatsapp: waDigits(agent.whatsapp_number),
        },
        contact: {
          name: buyersAgent.name,
          firstName: firstWord(buyersAgent.name) ?? buyersAgent.name,
          whatsapp: waDigits(buyersAgent.whatsapp),
        },
        orn: ctx.orn,
        permitNumber: unit.permitNumber!,
        expiresAt: iso(share.expires_at)!,
      },
    };
  });
}

/** The private page's listing, or null when the link does not work (one answer for every reason). */
export async function pocketShareView(token: string): Promise<{ organizationId: string; shareId: string; view: PocketView } | null> {
  const found = await findShare(token);
  return found ? { organizationId: found.organizationId, shareId: found.shareId, view: found.view } : null;
}

/** A view, counted at most once per ten minutes, so a refresh is not a second view. */
export async function notePocketView(organizationId: string, shareId: string): Promise<void> {
  return withTenant(organizationId, async () => {
    await getPool().query(
      `update unit_pocket_shares
          set view_count = view_count + 1, first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now()
        where organization_id = $1 and id = $2
          and (last_viewed_at is null or last_viewed_at < now() - make_interval(mins => $3))`,
      [organizationId, shareId, VIEW_EVERY_MINUTES]
    );
  });
}

/** One of the link's unit's photos, while the link works; null otherwise. */
export async function pocketPhoto(token: string, photoId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const found = await findShare(token);
  if (!found) return null;
  return withTenant(found.organizationId, async () => {
    const { rows } = await getPool().query<{ bytes: Buffer }>(
      `select bytes from unit_photos where organization_id = $1 and unit_id = $2 and id::text = $3`,
      [found.organizationId, found.unitId, photoId]
    );
    return rows[0] ? new Uint8Array(rows[0].bytes) : null;
  });
}

/**
 * "I'm interested": recorded the first time; `first` says whether this press
 * was it, `notify` whom to tell (the unit's agent, else whoever shared it).
 */
export async function recordPocketInterest(token: string): Promise<{
  first: boolean;
  notify: string | null;
  title: string;
  recipientFirstName: string | null;
  agentFirstName: string | null;
} | null> {
  const found = await findShare(token);
  if (!found) return null;
  return withTenant(found.organizationId, async () => {
    const { rowCount } = await getPool().query(
      `update unit_pocket_shares set interested_at = now() where organization_id = $1 and id = $2 and interested_at is null`,
      [found.organizationId, found.shareId]
    );
    // The buyer's own agent hears it (final review): they hold the client and can act on it.
    return {
      first: (rowCount ?? 0) > 0,
      notify: found.contactId,
      title: found.view.title,
      recipientFirstName: found.view.recipientFirstName,
      agentFirstName: found.view.contact.firstName,
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
