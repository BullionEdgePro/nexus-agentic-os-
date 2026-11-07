import {
  closeProblem,
  moveProblem,
  purposeAfterMove,
  type Board,
  type BoardDeal,
  type BoardUnit,
  type CardMove,
  type DealStep,
  type Portal,
  type PropertyType,
  type Purpose,
} from "@nexus/shared";
import { getPool, withTenant } from "./client.js";
import { contactServedBy } from "./contacts.js";

/**
 * The workflow board's records (3 Nov 2026): SFS staff move units through the
 * supply steps and deals through the demand steps of the boss's workflow.
 *
 * WHO SEES WHAT. Units are the business's inventory: every staff member sees
 * and works every unit, but an owner's name only shows to someone whose book
 * holds that customer. A deal is seen by whoever holds its customer in their
 * book (`contacts.owner_employee_id`) or is assigned it, and by an operator;
 * everyone else sees a count per step. Visibility is worked out on every read,
 * so a customer moved to a colleague's book takes the deal with them.
 *
 * A MOVE LANDS ONCE. It names the step it sets out from; if the card has moved
 * since, the caller is told where it is now and nothing is written.
 *
 * NOTHING IS CAUGHT. The rules are checked before a write rather than left to
 * a check constraint to refuse: a caught error inside the request's
 * transaction would quietly roll back everything else it did.
 *
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §3, §5
 */

/** Who is looking: an operator sees all; "View as staff" has no employeeId. */
export type Viewer = { employeeId: string | null; seesAll: boolean };
/** Who is acting: always exactly one person. */
export type Actor = { employeeId: string } | { adminId: string };

export type UnitFields = Partial<{
  reference: string;
  community: string | null;
  propertyType: PropertyType | null;
  bedrooms: number | null;
  priceAed: number | null;
  cheques: number | null;
  ejariReady: boolean;
  titleDeed: boolean;
  ownerDocs: boolean;
  formASignedOn: string | null;
  permitNumber: string | null;
  permitExpiresOn: string | null;
  liveOn: Portal[];
  ownerContactId: string | null;
  agentEmployeeId: string | null;
  notes: string | null;
  // The listing (spec 2026-11-07-portal-listings-design.md §2).
  title: string | null;
  description: string | null;
  sizeSqft: number | null;
  bathrooms: number | null;
  furnishing: BoardUnit["furnishing"];
  city: string;
  subCommunity: string | null;
  building: string | null;
  parking: number | null;
  amenities: string[];
  availableFrom: string | null;
}>;

export type DealFields = Partial<{
  budgetAed: number | null;
  offerAed: number | null;
  ejariNumber: string | null;
  kycDone: boolean;
  formFSignedOn: string | null;
  dldTransferOn: string | null;
  dealValueAed: number | null;
  commissionAed: number | null;
  agentEmployeeId: string | null;
  notes: string | null;
}>;

export type NewDeal = DealFields & { contactId: string; purpose: Purpose; step?: "D3" | "D4" };
export type Refused = { refused: string };
export type MoveResult<C> = { ok: C } | { moved: string } | { closed: true } | Refused | null;
export type CloseResult = { ok: true } | { closed: true } | Refused | null;

const UNIT_COLUMNS: Record<keyof UnitFields, string> = {
  reference: "reference",
  community: "community",
  propertyType: "property_type",
  bedrooms: "bedrooms",
  priceAed: "price_aed",
  cheques: "cheques",
  ejariReady: "ejari_ready",
  titleDeed: "title_deed",
  ownerDocs: "owner_docs",
  formASignedOn: "form_a_signed_on",
  permitNumber: "permit_number",
  permitExpiresOn: "permit_expires_on",
  liveOn: "live_on",
  ownerContactId: "owner_contact_id",
  agentEmployeeId: "agent_employee_id",
  notes: "notes",
  title: "title",
  description: "description",
  sizeSqft: "size_sqft",
  bathrooms: "bathrooms",
  furnishing: "furnishing",
  city: "city",
  subCommunity: "sub_community",
  building: "building",
  parking: "parking",
  amenities: "amenities",
  availableFrom: "available_from",
};

const DEAL_COLUMNS: Record<keyof DealFields, string> = {
  budgetAed: "budget_aed",
  offerAed: "offer_aed",
  ejariNumber: "ejari_number",
  kycDone: "kyc_done",
  formFSignedOn: "form_f_signed_on",
  dldTransferOn: "dld_transfer_on",
  dealValueAed: "deal_value_aed",
  commissionAed: "commission_aed",
  agentEmployeeId: "agent_employee_id",
  notes: "notes",
};

const NOT_STAFF = "That person is not on this business's staff.";
const KEEP_PERMIT = "An advertised unit keeps its Form A date, Trakheesi permit number and permit expiry.";

// $1 business, $2 sees all, $3 the viewer's employee id.
const SEES_DEAL = `($2::boolean or ct.owner_employee_id = $3::uuid or d.agent_employee_id = $3::uuid)`;

const UNIT_SELECT = `
  select u.id, u.step, u.in_step_since, u.reference, u.community, u.property_type, u.bedrooms, u.purpose,
         u.price_aed::text as price_aed, u.cheques, u.ejari_ready, u.title_deed, u.owner_docs,
         u.form_a_signed_on::text as form_a_signed_on, u.permit_number, u.permit_expires_on::text as permit_expires_on,
         u.live_on, u.owner_contact_id, u.notes, u.closed_at, u.updated_at,
         u.title, u.description, u.size_sqft::text as size_sqft, u.bathrooms, u.furnishing, u.city,
         u.sub_community, u.building, u.parking, u.amenities, u.available_from::text as available_from,
         coalesce((
           select json_agg(json_build_object('id', p.id, 'width', p.width, 'height', p.height) order by p.position)
             from unit_photos p
            where p.unit_id = u.id
         ), '[]'::json) as photos,
         coalesce((select json_object_agg(up.portal, up.wanted) from unit_portals up where up.unit_id = u.id), '{}'::json) as portals,
         case when $2::boolean or oc.owner_employee_id = $3::uuid
              then coalesce(oc.display_name, oc.external_id, oc.wa_id) end as owner_name,
         ag.id as agent_id, ag.full_name as agent_name,
         coalesce((
           select array_agg(du.deal_id::text order by du.added_at)
             from property_deal_units du
             join property_deals d on d.id = du.deal_id
             left join contacts ct on ct.id = d.contact_id
            where du.unit_id = u.id and d.closed_at is null and ${SEES_DEAL}
         ), '{}') as deal_ids
    from property_units u
    left join contacts oc on oc.id = u.owner_contact_id
    left join employees ag on ag.id = u.agent_employee_id
   where u.organization_id = $1`;

const DEAL_SELECT = `
  select d.id, d.step, d.in_step_since, d.contact_id, d.purpose,
         coalesce(ct.display_name, ct.external_id, ct.wa_id) as contact_name,
         d.budget_aed::text as budget_aed, d.offer_aed::text as offer_aed,
         d.ejari_number, d.kyc_done, d.form_f_signed_on::text as form_f_signed_on, d.dld_transfer_on::text as dld_transfer_on,
         d.deal_value_aed::text as deal_value_aed, d.commission_aed::text as commission_aed,
         d.notes, d.closed_at,
         ag.id as agent_id, ag.full_name as agent_name,
         coalesce((select array_agg(du.unit_id::text order by du.added_at) from property_deal_units du where du.deal_id = d.id), '{}') as unit_ids,
         (select min(b.starts_at) from bookings b
           where b.organization_id = $1 and b.contact_id = d.contact_id
             and b.status = 'confirmed' and b.starts_at >= now()) as next_viewing_at
    from property_deals d
    left join contacts ct on ct.id = d.contact_id
    -- Worked by whoever was named, else by whoever holds the customer in
    -- their book here: shown, not stored, so it moves with the book.
    left join employees ag on ag.id = coalesce(d.agent_employee_id, ct.owner_employee_id) and ag.organization_id = $1
   where d.organization_id = $1 and ${SEES_DEAL}`;

type Row = Record<string, unknown>;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown) => new Date(v as string | Date).toISOString();
const person = (row: Row) => (row.agent_id ? { id: String(row.agent_id), name: String(row.agent_name) } : null);

function toUnit(row: Row): BoardUnit {
  return {
    kind: "unit",
    id: String(row.id),
    step: row.step as BoardUnit["step"],
    inStepSince: iso(row.in_step_since),
    reference: String(row.reference),
    community: str(row.community),
    propertyType: (row.property_type as PropertyType | null) ?? null,
    bedrooms: num(row.bedrooms),
    purpose: (row.purpose as Purpose | null) ?? null,
    priceAed: num(row.price_aed),
    cheques: num(row.cheques),
    ejariReady: Boolean(row.ejari_ready),
    titleDeed: Boolean(row.title_deed),
    ownerDocs: Boolean(row.owner_docs),
    formASignedOn: str(row.form_a_signed_on),
    permitNumber: str(row.permit_number),
    permitExpiresOn: str(row.permit_expires_on),
    liveOn: (row.live_on as Portal[] | null) ?? [],
    owner: row.owner_contact_id ? { contactId: String(row.owner_contact_id), name: str(row.owner_name) } : null,
    agent: person(row),
    notes: str(row.notes),
    dealIds: (row.deal_ids as string[] | null) ?? [],
    updatedAt: iso(row.updated_at),
    title: str(row.title),
    description: str(row.description),
    sizeSqft: num(row.size_sqft),
    bathrooms: num(row.bathrooms),
    furnishing: (row.furnishing as BoardUnit["furnishing"]) ?? null,
    city: String(row.city ?? "Dubai"),
    subCommunity: str(row.sub_community),
    building: str(row.building),
    parking: num(row.parking),
    amenities: (row.amenities as string[] | null) ?? [],
    availableFrom: str(row.available_from),
    photos: ((row.photos as { id: string; width: number; height: number }[] | null) ?? []).map((p) => ({
      id: String(p.id),
      width: Number(p.width),
      height: Number(p.height),
    })),
    portals: wantedPortals(row.portals as Record<string, boolean> | null),
  };
}

/** All three switches, off unless a row says otherwise. */
function wantedPortals(rows: Record<string, boolean> | null): BoardUnit["portals"] {
  return {
    bayut: { wanted: rows?.bayut === true },
    dubizzle: { wanted: rows?.dubizzle === true },
    property_finder: { wanted: rows?.property_finder === true },
  };
}

function toDeal(row: Row): BoardDeal {
  return {
    kind: "deal",
    id: String(row.id),
    step: row.step as DealStep,
    inStepSince: iso(row.in_step_since),
    contact: { id: String(row.contact_id), name: str(row.contact_name) },
    purpose: row.purpose as Purpose,
    budgetAed: num(row.budget_aed),
    offerAed: num(row.offer_aed),
    ejariNumber: str(row.ejari_number),
    kycDone: Boolean(row.kyc_done),
    formFSignedOn: str(row.form_f_signed_on),
    dldTransferOn: str(row.dld_transfer_on),
    dealValueAed: num(row.deal_value_aed),
    commissionAed: num(row.commission_aed),
    agent: person(row),
    notes: str(row.notes),
    unitIds: (row.unit_ids as string[] | null) ?? [],
    nextViewingAt: row.next_viewing_at ? iso(row.next_viewing_at) : null,
  };
}

const viewArgs = (organizationId: string, viewer: Viewer) => [organizationId, viewer.seesAll, viewer.employeeId];
const actorIds = (actor: Actor): [string | null, string | null] =>
  "employeeId" in actor ? [actor.employeeId, null] : [null, actor.adminId];

/** One unit as this viewer sees it, closed or not; `lock` takes the row for a write. */
async function readUnit(organizationId: string, viewer: Viewer, id: string, lock = false): Promise<(BoardUnit & { closed: boolean }) | null> {
  const { rows } = await getPool().query(`${UNIT_SELECT} and u.id = $4${lock ? " for update of u" : ""}`, [...viewArgs(organizationId, viewer), id]);
  return rows[0] ? { ...toUnit(rows[0]), closed: rows[0].closed_at !== null } : null;
}

/**
 * Units of this business as this viewer sees them, narrowed by `where` (its
 * parameters start at $4). For the portal listings module; the caller runs it
 * inside withTenant.
 */
export async function unitsWhere(
  organizationId: string,
  viewer: Viewer,
  where: string,
  args: unknown[],
  orderBy = "u.in_step_since"
): Promise<(BoardUnit & { closed: boolean })[]> {
  const { rows } = await getPool().query(`${UNIT_SELECT} and ${where} order by ${orderBy}`, [...viewArgs(organizationId, viewer), ...args]);
  return rows.map((row) => ({ ...toUnit(row), closed: row.closed_at !== null }));
}

/** One deal, only if this viewer may see it. */
async function readDeal(organizationId: string, viewer: Viewer, id: string, lock = false): Promise<(BoardDeal & { closed: boolean }) | null> {
  const { rows } = await getPool().query(`${DEAL_SELECT} and d.id = $4${lock ? " for update of d" : ""}`, [...viewArgs(organizationId, viewer), id]);
  return rows[0] ? { ...toDeal(rows[0]), closed: rows[0].closed_at !== null } : null;
}

const strip = <C extends { closed: boolean }>(card: C): Omit<C, "closed"> => {
  const { closed: _closed, ...rest } = card;
  return rest;
};

async function businessToday(timezone: string): Promise<string> {
  const { rows } = await getPool().query<{ today: string }>(`select (now() at time zone $1)::date::text as today`, [timezone]);
  return rows[0].today;
}

async function isStaff(organizationId: string, employeeId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`select 1 from employees where id = $1 and organization_id = $2`, [employeeId, organizationId]);
  return (rowCount ?? 0) > 0;
}

/** A customer this business serves — owned, or reached on a shared number. */
async function servedContact(organizationId: string, contactId: string): Promise<{ ownerEmployeeId: string | null } | null> {
  const { rows } = await getPool().query<{ owner_employee_id: string | null }>(
    `select ct.owner_employee_id from contacts ct where ct.id = $1 and ${contactServedBy("$2")}`,
    [contactId, organizationId]
  );
  return rows[0] ? { ownerEmployeeId: rows[0].owner_employee_id } : null;
}

/**
 * A customer this viewer may name: served by the business and, for staff, in
 * their own book (final review, 3 Nov 2026). A colleague's client reads exactly
 * like a stranger — the board hands out owners' contact ids, and an id typed
 * into a request must open nothing the contacts screen would not.
 */
async function bookContact(organizationId: string, viewer: Viewer, contactId: string): Promise<{ ownerEmployeeId: string | null } | null> {
  const contact = await servedContact(organizationId, contactId);
  if (!contact) return null;
  return viewer.seesAll || (viewer.employeeId !== null && contact.ownerEmployeeId === viewer.employeeId) ? contact : null;
}

async function logMove(
  organizationId: string,
  actor: Actor,
  card: { unitId: string } | { dealId: string },
  kind: CardMove["kind"],
  from: string | null,
  to: string | null,
  closedReason: string | null = null
): Promise<void> {
  const [employeeId, adminId] = actorIds(actor);
  await getPool().query(
    `insert into workflow_moves (organization_id, unit_id, deal_id, kind, from_step, to_step, closed_reason, by_employee_id, by_admin_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [organizationId, "unitId" in card ? card.unitId : null, "dealId" in card ? card.dealId : null, kind, from, to, closedReason, employeeId, adminId]
  );
}

/** `col = $n` pairs for the fields given, starting at parameter `first`. */
function setClause(fields: object, columns: Record<string, string>, first: number): { sql: string[]; args: unknown[] } {
  const sql: string[] = [];
  const args: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const column = columns[key];
    if (!column || value === undefined) continue;
    args.push(value);
    sql.push(`${column} = $${first + args.length - 1}`);
  }
  return { sql, args };
}

/** The open board as one viewer sees it. */
export async function getBoard(input: { organizationId: string; timezone: string; viewer: Viewer }): Promise<Board> {
  const { organizationId, timezone, viewer } = input;
  return withTenant(organizationId, async () => {
    const db = getPool();
    const args = viewArgs(organizationId, viewer);
    const units = await db.query(`${UNIT_SELECT} and u.closed_at is null order by u.in_step_since`, args);
    const deals = await db.query(`${DEAL_SELECT} and d.closed_at is null order by d.in_step_since`, args);
    const hidden = await db.query<{ step: DealStep; n: number }>(
      `select d.step, count(*)::int as n
         from property_deals d left join contacts ct on ct.id = d.contact_id
        where d.organization_id = $1 and d.closed_at is null and not coalesce(${SEES_DEAL}, false)
        group by d.step`,
      args
    );
    // Hot = high or urgent in the last 30 days, for this business as the one
    // serving the chat (the audit's own meaning), and no open deal yet.
    const hot = await db.query(
      `select * from (
         select distinct on (la.contact_id)
                la.contact_id, coalesce(ct.display_name, ct.external_id, ct.wa_id) as name, la.priority, la.created_at
           from lead_assessments la
           join contacts ct on ct.id = la.contact_id
          where la.serving_organization_id = $1
            and la.priority in ('high', 'urgent')
            and la.created_at >= now() - interval '30 days'
            and ($2::boolean or ct.owner_employee_id = $3::uuid)
            and not exists (select 1 from property_deals d
                             where d.organization_id = $1 and d.contact_id = la.contact_id and d.closed_at is null)
          order by la.contact_id, la.created_at desc
       ) h order by h.created_at desc limit 20`,
      args
    );
    const closed = await db.query<{ let: number; sold: number; won: number; commission: string }>(
      `select (select count(*)::int from property_units where organization_id = $1 and closed_reason = 'let' and closed_at >= now() - interval '30 days') as let,
              (select count(*)::int from property_units where organization_id = $1 and closed_reason = 'sold' and closed_at >= now() - interval '30 days') as sold,
              (select count(*)::int from property_deals where organization_id = $1 and closed_reason = 'won' and closed_at >= now() - interval '30 days') as won,
              (select coalesce(sum(commission_aed), 0)::text from property_deals where organization_id = $1 and closed_reason = 'won' and closed_at >= now() - interval '30 days') as commission`,
      [organizationId]
    );
    const c = closed.rows[0];
    // What the Portals section needs to say what is missing (portal listings, 7 Nov 2026).
    const settings = await db.query<{ orn: string | null; feed_token: string | null; feed_last_read_at: Date | null }>(
      `select orn, feed_token, feed_last_read_at from portal_settings where organization_id = $1`,
      [organizationId]
    );
    const s = settings.rows[0];
    const brns = await db.query<{ id: string; has: boolean; is_active: boolean }>(
      `select e.id, e.brn is not null as has, e.is_active
         from employees e
        where e.organization_id = $1
          and e.id in (select u.agent_employee_id from property_units u
                        where u.organization_id = $1 and u.closed_at is null and u.agent_employee_id is not null)`,
      [organizationId]
    );
    return {
      units: units.rows.map(toUnit),
      deals: deals.rows.map(toDeal),
      hidden: Object.fromEntries(hidden.rows.map((r) => [r.step, r.n])),
      hotWaiting: hot.rows.map((r) => ({
        contactId: String(r.contact_id),
        name: str(r.name),
        priority: r.priority as "high" | "urgent",
        scoredAt: iso(r.created_at),
      })),
      closed30: { let: c.let, sold: c.sold, won: c.won, commissionAed: Number(c.commission) },
      today: await businessToday(timezone),
      portalFeed: s?.feed_token ? { lastReadAt: s.feed_last_read_at ? iso(s.feed_last_read_at) : null } : null,
      ornSet: !!s?.orn,
      agentBrns: Object.fromEntries(brns.rows.map((r) => [String(r.id), r.has])),
      agentsGone: brns.rows.filter((r) => !r.is_active).map((r) => String(r.id)),
    };
  });
}

/** A new unit on S5, worked by the person adding it unless another is named. */
export async function createUnit(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  fields: UnitFields & { reference: string }
): Promise<BoardUnit | Refused | "no-contact"> {
  return withTenant(organizationId, async () => {
    if (!fields.reference?.trim()) return { refused: "A unit needs a reference." };
    if (fields.ownerContactId && !(await bookContact(organizationId, viewer, fields.ownerContactId))) return "no-contact";
    const [employeeId, adminId] = actorIds(actor);
    const agent = fields.agentEmployeeId !== undefined ? fields.agentEmployeeId : employeeId;
    if (agent && !(await isStaff(organizationId, agent))) return { refused: NOT_STAFF };
    const { sql, args } = setClause({ ...fields, agentEmployeeId: agent }, UNIT_COLUMNS, 5);
    const columns = sql.map((s) => s.split(" = ")[0]);
    const { rows } = await getPool().query<{ id: string }>(
      `insert into property_units (organization_id, step, created_by_employee_id, created_by_admin_id${columns.map((c) => `, ${c}`).join("")})
       values ($1, $2, $3, $4${columns.map((_, i) => `, $${5 + i}`).join("")}) returning id`,
      [organizationId, "S5", employeeId, adminId, ...args]
    );
    await logMove(organizationId, actor, { unitId: rows[0].id }, "created", null, "S5");
    return strip((await readUnit(organizationId, viewer, rows[0].id))!);
  });
}

/** Saves the fields given; the step and the purpose change only by moving. */
export async function updateUnit(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  id: string,
  fields: UnitFields
): Promise<BoardUnit | "closed" | Refused | "no-contact" | null> {
  return withTenant(organizationId, async () => {
    const current = await readUnit(organizationId, viewer, id, true);
    if (!current) return null;
    if (current.closed) return "closed";
    const merged = { ...current, ...fields };
    if (fields.reference !== undefined && !fields.reference?.trim()) return { refused: "A unit needs a reference." };
    if ((merged.step === "S9" || merged.step === "S10") && (!merged.formASignedOn || !merged.permitNumber?.trim() || !merged.permitExpiresOn)) {
      return { refused: KEEP_PERMIT };
    }
    if (fields.ownerContactId && !(await bookContact(organizationId, viewer, fields.ownerContactId))) return "no-contact";
    if (fields.agentEmployeeId && !(await isStaff(organizationId, fields.agentEmployeeId))) return { refused: NOT_STAFF };
    const { sql, args } = setClause(fields, UNIT_COLUMNS, 5);
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `update property_units set ${[...sql, "updated_by_employee_id = $3", "updated_by_admin_id = $4", "updated_at = now()"].join(", ")}
        where organization_id = $1 and id = $2`,
      [organizationId, id, employeeId, adminId, ...args]
    );
    return strip((await readUnit(organizationId, viewer, id))!);
  });
}

export async function moveUnit(
  organizationId: string,
  timezone: string,
  actor: Actor,
  viewer: Viewer,
  id: string,
  from: string,
  to: string
): Promise<MoveResult<BoardUnit>> {
  return withTenant(organizationId, async () => {
    const current = await readUnit(organizationId, viewer, id, true);
    if (!current) return null;
    if (current.closed) return { closed: true };
    if (current.step !== from) return { moved: current.step };
    const problem = moveProblem(current, to, await businessToday(timezone));
    if (problem) return { refused: problem };
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `update property_units
          set step = $4, purpose = $5, in_step_since = now(), updated_at = now(), updated_by_employee_id = $6, updated_by_admin_id = $7
        where organization_id = $1 and id = $2 and step = $3 and closed_at is null`,
      [organizationId, id, from, to, purposeAfterMove(current, to), employeeId, adminId]
    );
    await logMove(organizationId, actor, { unitId: id }, "moved", from, to);
    return { ok: strip((await readUnit(organizationId, viewer, id))!) };
  });
}

/** A note given on closing is kept at the end of the card's notes. */
const CLOSE_NOTES = `notes = case when $4::text is null then notes else concat_ws(E'\\n', notes, 'Closed: ' || $4::text) end`;

export async function closeUnit(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  id: string,
  reason: string,
  note: string | null
): Promise<CloseResult> {
  return withTenant(organizationId, async () => {
    const current = await readUnit(organizationId, viewer, id, true);
    if (!current) return null;
    if (current.closed) return { closed: true };
    const problem = closeProblem(current, reason);
    if (problem) return { refused: problem };
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `update property_units set closed_at = now(), closed_reason = $3, ${CLOSE_NOTES},
              updated_at = now(), updated_by_employee_id = $5, updated_by_admin_id = $6
        where organization_id = $1 and id = $2`,
      [organizationId, id, reason, note?.trim() || null, employeeId, adminId]
    );
    await logMove(organizationId, actor, { unitId: id }, "closed", current.step, null, reason);
    return { ok: true };
  });
}

/**
 * A lead on the board: on D4, or D3 if asked. Staff add only customers in their
 * own book; an operator, any customer the business serves. Nobody is stored as
 * its agent unless named: it is worked by whoever holds the customer, and moves
 * with the book (final review, 3 Nov 2026). A second open deal for the same
 * lead and purpose is "duplicate" — the database's unique index decides, so two
 * people at once make one card.
 */
export async function createDeal(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  fields: NewDeal
): Promise<BoardDeal | "duplicate" | "no-contact" | Refused> {
  return withTenant(organizationId, async () => {
    if (!(await bookContact(organizationId, viewer, fields.contactId))) return "no-contact";
    const [employeeId, adminId] = actorIds(actor);
    if (fields.agentEmployeeId && !(await isStaff(organizationId, fields.agentEmployeeId))) return { refused: NOT_STAFF };
    const { contactId, purpose, step = "D4", ...rest } = fields;
    const { sql, args } = setClause(rest, DEAL_COLUMNS, 7);
    const columns = sql.map((s) => s.split(" = ")[0]);
    const { rows } = await getPool().query<{ id: string }>(
      `insert into property_deals (organization_id, contact_id, purpose, step, created_by_employee_id, created_by_admin_id${columns.map((c) => `, ${c}`).join("")})
       values ($1, $2, $3, $4, $5, $6${columns.map((_, i) => `, $${7 + i}`).join("")})
       on conflict (organization_id, contact_id, purpose) where closed_at is null do nothing
       returning id`,
      [organizationId, contactId, purpose, step, employeeId, adminId, ...args]
    );
    if (!rows[0]) return "duplicate";
    await logMove(organizationId, actor, { dealId: rows[0].id }, "created", null, step);
    // Read as the viewer: the customer is in their book, or they see everything.
    return strip((await readDeal(organizationId, viewer, rows[0].id))!);
  });
}

export async function updateDeal(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  id: string,
  fields: DealFields
): Promise<BoardDeal | "closed" | Refused | null> {
  return withTenant(organizationId, async () => {
    const current = await readDeal(organizationId, viewer, id, true);
    if (!current) return null;
    if (current.closed) return "closed";
    if (fields.agentEmployeeId && !(await isStaff(organizationId, fields.agentEmployeeId))) return { refused: NOT_STAFF };
    const { sql, args } = setClause(fields, DEAL_COLUMNS, 5);
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `update property_deals set ${[...sql, "updated_by_employee_id = $3", "updated_by_admin_id = $4", "updated_at = now()"].join(", ")}
        where organization_id = $1 and id = $2`,
      [organizationId, id, employeeId, adminId, ...args]
    );
    return strip((await readDeal(organizationId, { ...viewer, seesAll: true }, id))!);
  });
}

export async function moveDeal(
  organizationId: string,
  timezone: string,
  actor: Actor,
  viewer: Viewer,
  id: string,
  from: string,
  to: string
): Promise<MoveResult<BoardDeal>> {
  return withTenant(organizationId, async () => {
    const current = await readDeal(organizationId, viewer, id, true);
    if (!current) return null;
    if (current.closed) return { closed: true };
    if (current.step !== from) return { moved: current.step };
    const problem = moveProblem(current, to, await businessToday(timezone));
    if (problem) return { refused: problem };
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `update property_deals
          set step = $4, in_step_since = now(), updated_at = now(), updated_by_employee_id = $5, updated_by_admin_id = $6
        where organization_id = $1 and id = $2 and step = $3 and closed_at is null`,
      [organizationId, id, from, to, employeeId, adminId]
    );
    await logMove(organizationId, actor, { dealId: id }, "moved", from, to);
    return { ok: strip((await readDeal(organizationId, viewer, id))!) };
  });
}

export async function closeDeal(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  id: string,
  reason: string,
  note: string | null
): Promise<CloseResult> {
  return withTenant(organizationId, async () => {
    const current = await readDeal(organizationId, viewer, id, true);
    if (!current) return null;
    if (current.closed) return { closed: true };
    const problem = closeProblem(current, reason);
    if (problem) return { refused: problem };
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `update property_deals set closed_at = now(), closed_reason = $3, ${CLOSE_NOTES},
              updated_at = now(), updated_by_employee_id = $5, updated_by_admin_id = $6
        where organization_id = $1 and id = $2`,
      [organizationId, id, reason, note?.trim() || null, employeeId, adminId]
    );
    await logMove(organizationId, actor, { dealId: id }, "closed", current.step, null, reason);
    return { ok: true };
  });
}

/** Offers a unit to a deal (D4). Null when the deal or the unit is out of reach. */
export async function linkUnit(
  organizationId: string,
  actor: Actor,
  viewer: Viewer,
  dealId: string,
  unitId: string
): Promise<BoardDeal | "closed" | null> {
  return withTenant(organizationId, async () => {
    const deal = await readDeal(organizationId, viewer, dealId, true);
    if (!deal) return null;
    if (deal.closed) return "closed";
    const unit = await readUnit(organizationId, viewer, unitId);
    if (!unit) return null;
    const [employeeId, adminId] = actorIds(actor);
    await getPool().query(
      `insert into property_deal_units (organization_id, deal_id, unit_id, added_by_employee_id, added_by_admin_id)
       values ($1, $2, $3, $4, $5) on conflict (deal_id, unit_id) do nothing`,
      [organizationId, dealId, unitId, employeeId, adminId]
    );
    return strip((await readDeal(organizationId, viewer, dealId))!);
  });
}

export async function unlinkUnit(
  organizationId: string,
  _actor: Actor,
  viewer: Viewer,
  dealId: string,
  unitId: string
): Promise<BoardDeal | null> {
  return withTenant(organizationId, async () => {
    const deal = await readDeal(organizationId, viewer, dealId, true);
    if (!deal) return null;
    await getPool().query(`delete from property_deal_units where organization_id = $1 and deal_id = $2 and unit_id = $3`, [
      organizationId,
      dealId,
      unitId,
    ]);
    return strip((await readDeal(organizationId, viewer, dealId))!);
  });
}

/** A card's history, oldest first, with names; null when the card is out of reach. */
export async function cardHistory(organizationId: string, viewer: Viewer, kind: "unit" | "deal", id: string): Promise<CardMove[] | null> {
  return withTenant(organizationId, async () => {
    const card = kind === "unit" ? await readUnit(organizationId, viewer, id) : await readDeal(organizationId, viewer, id);
    if (!card) return null;
    const { rows } = await getPool().query(
      `select m.kind, m.from_step, m.to_step, m.closed_reason, m.at, coalesce(e.full_name, a.full_name) as by_name
         from workflow_moves m
         left join employees e on e.id = m.by_employee_id
         left join admins a on a.id = m.by_admin_id
        where m.organization_id = $1 and ${kind === "unit" ? "m.unit_id" : "m.deal_id"} = $2
        order by m.at, case m.kind when 'created' then 0 when 'moved' then 1 else 2 end`,
      [organizationId, id]
    );
    return rows.map((r) => ({
      kind: r.kind as CardMove["kind"],
      from: str(r.from_step),
      to: str(r.to_step),
      closedReason: str(r.closed_reason),
      by: str(r.by_name),
      at: iso(r.at),
    }));
  });
}
