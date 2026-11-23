import { Hono, type Context } from "hono";
import {
  addUnitPhoto,
  autoLinkBayutAgents,
  bayutAgentLinks,
  bayutConnectionView,
  bayutToken,
  cardHistory,
  clearBayutConnection,
  clearPfConnection,
  closeDeal,
  createPocketShare,
  closeUnit,
  createDeal,
  createUnit,
  findOrganizationBySlug,
  getBoard,
  linkBayutAgent,
  linkUnit,
  moveDeal,
  moveUnit,
  newPortalFeed,
  orderUnitPhotos,
  pfConnectionView,
  pfCredentials,
  portalAgents,
  portalSettings,
  recordBayutCheck,
  recordPfCheck,
  removeUnitPhoto,
  revokePocketShare,
  saveBayutConnection,
  savePfConnection,
  setEmployeeBrn,
  setUnitPocket,
  setPortalOrn,
  setUnitPortal,
  unitPhotoBytes,
  unlinkUnit,
  updateDeal,
  updateUnit,
  type Actor,
  type BayutLocationFields,
  type DealFields,
  type UnitFields,
  type Viewer,
} from "@nexus/db";
import {
  AMENITIES,
  FURNISHING,
  PF_LISTING_CALLS_READY,
  pocketMessage,
  PORTAL_TARGETS,
  PORTALS,
  PROPERTY_TYPES,
  REAL_ESTATE_WORKFLOW,
  whatsappLink,
  workflowFor,
  xmlSafe,
  type PortalTarget,
} from "@nexus/shared";
import { bayutClient, type BayutAnswer } from "../lib/bayut.js";
import { bayutCheckOf, bayutUsersKey, type BayutCheck } from "../lib/bayut-check.js";
import { bayutPaused, bayutRedis, pauseBayut, takeBayutCalls } from "../lib/bayut-budget.js";
import { PHOTO_MAX_BYTES, PHOTO_TOO_LARGE, readBoardPhoto } from "../lib/board-photo-upload.js";
import { jpegSize } from "../lib/jpeg-size.js";
import { pfClient, type PfAnswer } from "../lib/property-finder.js";
import { apiBaseUrl, appBaseUrl } from "../lib/public-urls.js";
import { queueBayutCycle, queueBayutUnit } from "../queue/bayut-sync-queue.js";
import { queuePfCycle, queuePfUnit } from "../queue/pf-sync-queue.js";
import type { SessionScope } from "../lib/session.js";

/**
 * The workflow board (3 Nov 2026): SFS staff move units and deals through the
 * boss's workflow.
 *
 * MOUNTED UNDER /api/organizations/:slug, like the workflow audit, so
 * `requireTenantScope` lets an operator into any business and staff only into
 * their own, and every read and write runs as that business.
 *
 * WHO ACTED comes from the session — the employee, or the operator's admin
 * account — and never from the request body. "View as staff" narrows an
 * operator to a staff view with nobody's name on it, so it may look but not
 * change anything: a change credited to nobody is worse than no change.
 *
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §3, §7
 */
export const workflowBoardRoute = new Hono();

const scopeOf = (c: Context) => (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" as const };

function viewerOf(scope: SessionScope): Viewer {
  return scope.role === "operator" ? { employeeId: null, seesAll: true } : { employeeId: scope.employeeId ?? null, seesAll: false };
}

function actorOf(scope: SessionScope): Actor | null {
  if (scope.role === "operator") return scope.adminId ? { adminId: scope.adminId } : null;
  return scope.employeeId ? { employeeId: scope.employeeId } : null;
}

const stepName = (id: string) => REAL_ESTATE_WORKFLOW.steps.find((s) => s.id === id)?.name ?? id;

const LOOK_ONLY = "Viewing as staff is look-only here.";
const CLOSED = "This card is closed.";

/** The business, if it has a drawn workflow; otherwise the answer to send. */
async function boardBusiness(c: Context) {
  const organization = await findOrganizationBySlug(c.req.param("slug") ?? "");
  if (!organization) return { answer: c.json({ error: "Organization not found" }, 404) };
  if (!workflowFor(organization.slug)) return { answer: c.json({ error: "This business has no workflow." }, 404) };
  return { organization };
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Fields. Unknown keys are dropped — the step and the purpose among them: those
// change only by moving.
// ---------------------------------------------------------------------------

type Parse<T> = { fields: T } | { error: string };
type Check = (v: unknown) => { ok: true; value: unknown } | { ok: false };

const ok = (value: unknown) => ({ ok: true as const, value });
const bad = { ok: false as const };
const nullable = (check: Check): Check => (v) => (v === null ? ok(null) : check(v));

/** Dirhams: a number, or digits with an optional decimal point — never "1,200,000" or "85k". */
const money: Check = nullable((v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? ok(n) : bad;
});
const whole = (min: number, max: number): Check => nullable((v) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? ok(v) : bad));
const flag: Check = (v) => (typeof v === "boolean" ? ok(v) : bad);
const day: Check = nullable((v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return bad;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? ok(v) : bad;
});
/** Optional text: trimmed; blank is nothing. */
const text = (max: number): Check => nullable((v) => (typeof v === "string" && v.length <= max ? ok(v.trim() || null) : bad));
const oneOf = (values: readonly string[]): Check => nullable((v) => (typeof v === "string" && values.includes(v) ? ok(v) : bad));
const id: Check = nullable((v) => (typeof v === "string" && v.length > 0 && v.length <= 64 ? ok(v) : bad));
const portals: Check = (v) =>
  Array.isArray(v) && v.every((p) => (PORTALS as readonly unknown[]).includes(p)) && new Set(v).size === v.length ? ok(v) : bad;
/** A unit's reference: trimmed, kept even when blank so the rule can refuse it. */
const reference: Check = (v) => (typeof v === "string" && v.length <= 200 ? ok(v.trim()) : bad);
/** A size in sq ft: like money, but more than nothing. */
const area: Check = nullable((v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1e8 ? ok(n) : bad;
});
/**
 * Listing text: like text(), with the characters the portals' XML forbids made
 * spaces (final review), so the card shows exactly what the feed publishes.
 */
const listingText = (max: number): Check =>
  nullable((v) => (typeof v === "string" && v.length <= max ? ok(xmlSafe(v).trim() || null) : bad));
/** The city: blank is Dubai, the business's own. */
const city: Check = (v) =>
  v === null ? ok("Dubai") : typeof v === "string" && v.length <= 100 ? ok(xmlSafe(v).trim() || "Dubai") : bad;
/** Amenities: known keys, each once. */
const amenities: Check = (v) =>
  Array.isArray(v) && v.every((a) => (AMENITIES as readonly unknown[]).includes(a)) && new Set(v).size === v.length ? ok(v) : bad;

const UNIT_CHECKS: Record<keyof UnitFields, Check> = {
  reference,
  community: text(200),
  propertyType: oneOf(PROPERTY_TYPES),
  bedrooms: whole(0, 50),
  priceAed: money,
  cheques: whole(1, 12),
  ejariReady: flag,
  titleDeed: flag,
  ownerDocs: flag,
  formASignedOn: day,
  permitNumber: text(100),
  permitExpiresOn: day,
  liveOn: portals,
  ownerContactId: id,
  agentEmployeeId: id,
  notes: text(4000),
  title: listingText(120),
  description: listingText(5000),
  sizeSqft: area,
  bathrooms: whole(0, 20),
  furnishing: oneOf(FURNISHING),
  city,
  subCommunity: listingText(200),
  building: listingText(200),
  parking: whole(0, 20),
  amenities,
  availableFrom: day,
};

const DEAL_CHECKS: Record<keyof DealFields, Check> = {
  budgetAed: money,
  offerAed: money,
  ejariNumber: text(100),
  kycDone: flag,
  formFSignedOn: day,
  dldTransferOn: day,
  dealValueAed: money,
  commissionAed: money,
  agentEmployeeId: id,
  notes: text(4000),
};

function parseWith<T>(raw: Record<string, unknown>, checks: Record<string, Check>): Parse<T> {
  const fields: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(checks)) {
    if (!(key in raw) || raw[key] === undefined) continue;
    const result = check(raw[key]);
    if (!result.ok) return { error: `Invalid ${key}.` };
    fields[key] = result.value;
  }
  return { fields: fields as T };
}

export const parseUnitFields = (raw: Record<string, unknown>) => parseWith<UnitFields>(raw, UNIT_CHECKS);
export const parseDealFields = (raw: Record<string, unknown>) => parseWith<DealFields>(raw, DEAL_CHECKS);

/** Postgres's integer: the column Bayut's location id is kept in. */
const INTEGER_MAX = 2_147_483_647;

/**
 * The unit's Bayut location (23 Nov 2026): Bayut's location id and the name
 * staff picked, both or neither, set on an existing card only. Checked apart
 * from UNIT_CHECKS because the two are checked together.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §6, §12
 */
function parseBayutLocation(raw: Record<string, unknown>): BayutLocationFields | { error: string } {
  const { bayutLocationId: id, bayutLocationName: name } = raw;
  if (id === undefined && name === undefined) return {};
  if (id === null && name === null) return { bayutLocationId: null, bayutLocationName: null };
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (typeof id === "number" && Number.isInteger(id) && id > 0 && id <= INTEGER_MAX && trimmed.length > 0 && trimmed.length <= 300) {
    return { bayutLocationId: id, bayutLocationName: trimmed };
  }
  return { error: "Invalid bayutLocation." };
}

// ---------------------------------------------------------------------------
// Answers shared by units and deals
// ---------------------------------------------------------------------------

type MoveAnswer = { ok: unknown } | { moved: string } | { closed: true } | { refused: string } | null;
type CloseAnswer = { ok: true } | { closed: true } | { refused: string } | null;

function answerMove(c: Context, result: MoveAnswer) {
  if (result === null) return c.json({ error: "Card not found" }, 404);
  // The sentence alone: the console shows a body that is {"error":"…"} and
  // nothing else, and the board reloads to show where the card went.
  if ("moved" in result) return c.json({ error: `Someone moved this card to ${stepName(result.moved)} a moment ago.` }, 409);
  if ("closed" in result) return c.json({ error: CLOSED }, 409);
  if ("refused" in result) return c.json({ error: result.refused }, 422);
  return c.json(result.ok);
}

function answerClose(c: Context, result: CloseAnswer) {
  if (result === null) return c.json({ error: "Card not found" }, 404);
  if ("closed" in result) return c.json({ error: CLOSED }, 409);
  if ("refused" in result) return c.json({ error: result.refused }, 422);
  return c.json({ ok: true });
}

/**
 * Property Finder follows a unit half a minute after a write to it succeeds
 * (7 Nov 2026) — listing details, photos, the switch, a move or a close all
 * change what should be on Property Finder — and so does Bayut (23 Nov 2026),
 * the Bayut location among them. Never in the way of the write, and neither
 * queue in the way of the other: when Redis is down the ten-minute cycles pick
 * the change up.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §10, §12
 */
function followOnPortals(res: Response, organizationId: string, unitId: string): Response {
  if (res.status >= 200 && res.status < 300) {
    void queuePfUnit(organizationId, unitId).catch((err) =>
      console.error("[property-finder] could not queue the unit:", err instanceof Error ? err.message : err)
    );
    void queueBayutUnit(organizationId, unitId).catch((err) =>
      console.error("[bayut] could not queue the unit:", err instanceof Error ? err.message : err)
    );
  }
  return res;
}

/** A card, or one of the module's other answers, as a response. */
function answerCard(c: Context, result: unknown, created = false) {
  if (result === null) return c.json({ error: "Card not found" }, 404);
  if (result === "closed") return c.json({ error: CLOSED }, 409);
  if (result === "duplicate") return c.json({ error: "This lead is already on the board." }, 409);
  if (result === "no-contact") return c.json({ error: "Customer not found" }, 404);
  if (typeof result === "object" && result && "refused" in result) return c.json({ error: (result as { refused: string }).refused }, 422);
  return c.json(result, created ? 201 : 200);
}

function moveBody(raw: Record<string, unknown>): { from: string; to: string } | null {
  return typeof raw.from === "string" && typeof raw.to === "string" ? { from: raw.from, to: raw.to } : null;
}

function closeBody(raw: Record<string, unknown>): { reason: string; note: string | null } | null {
  if (typeof raw.reason !== "string") return null;
  if (raw.note !== undefined && raw.note !== null && (typeof raw.note !== "string" || raw.note.length > 1000)) return null;
  return { reason: raw.reason, note: (raw.note as string | null | undefined) ?? null };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

workflowBoardRoute.get("/:slug/workflow-board", async (c) => {
  const { organization, answer } = await boardBusiness(c);
  if (!organization) return answer;
  const viewer = viewerOf(scopeOf(c));
  return c.json(await getBoard({ organizationId: organization.id, timezone: organization.timezone, viewer }));
});

workflowBoardRoute.get("/:slug/workflow-board/:kind/:id/history", async (c) => {
  const { organization, answer } = await boardBusiness(c);
  if (!organization) return answer;
  const kind = c.req.param("kind");
  if (kind !== "units" && kind !== "deals") return c.json({ error: "Not found" }, 404);
  const moves = await cardHistory(organization.id, viewerOf(scopeOf(c)), kind === "units" ? "unit" : "deal", c.req.param("id"));
  return moves === null ? c.json({ error: "Card not found" }, 404) : c.json({ moves });
});

/** Every write: the business, who acted, and who is looking — or the answer to send. */
async function writer(c: Context) {
  const { organization, answer } = await boardBusiness(c);
  if (!organization) return { answer };
  const scope = scopeOf(c);
  const actor = actorOf(scope);
  if (!actor) return { answer: c.json({ error: LOOK_ONLY }, 403) };
  return { organization, actor, viewer: viewerOf(scope) };
}

workflowBoardRoute.post("/:slug/workflow-board/units", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const parsed = parseUnitFields(await body(c));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const fields = { ...parsed.fields, reference: parsed.fields.reference ?? "" };
  return answerCard(c, await createUnit(w.organization.id, w.actor, w.viewer, fields), true);
});

workflowBoardRoute.patch("/:slug/workflow-board/units/:id", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const raw = await body(c);
  const parsed = parseUnitFields(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const location = parseBayutLocation(raw);
  if ("error" in location) return c.json({ error: location.error }, 400);
  const unitId = c.req.param("id");
  const fields = { ...parsed.fields, ...location };
  return followOnPortals(answerCard(c, await updateUnit(w.organization.id, w.actor, w.viewer, unitId, fields)), w.organization.id, unitId);
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/move", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const move = moveBody(await body(c));
  if (!move) return c.json({ error: "from and to must be step ids." }, 400);
  const unitId = c.req.param("id");
  return followOnPortals(
    answerMove(c, await moveUnit(w.organization.id, w.organization.timezone, w.actor, w.viewer, unitId, move.from, move.to)),
    w.organization.id,
    unitId
  );
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/close", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const close = closeBody(await body(c));
  if (!close) return c.json({ error: "reason is required." }, 400);
  const unitId = c.req.param("id");
  return followOnPortals(
    answerClose(c, await closeUnit(w.organization.id, w.actor, w.viewer, unitId, close.reason, close.note)),
    w.organization.id,
    unitId
  );
});

workflowBoardRoute.post("/:slug/workflow-board/deals", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const raw = await body(c);
  const parsed = parseDealFields(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  if (typeof raw.contactId !== "string" || !raw.contactId) return c.json({ error: "contactId is required." }, 400);
  if (raw.purpose !== "rent" && raw.purpose !== "sale") return c.json({ error: "purpose must be rent or sale." }, 400);
  if (raw.step !== undefined && raw.step !== "D3" && raw.step !== "D4") return c.json({ error: "A lead starts on D3 or D4." }, 400);
  const step = raw.step as "D3" | "D4" | undefined;
  const purpose: "rent" | "sale" = raw.purpose;
  const fields = { ...parsed.fields, contactId: raw.contactId, purpose, ...(step ? { step } : {}) };
  return answerCard(c, await createDeal(w.organization.id, w.actor, w.viewer, fields), true);
});

workflowBoardRoute.patch("/:slug/workflow-board/deals/:id", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const parsed = parseDealFields(await body(c));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  return answerCard(c, await updateDeal(w.organization.id, w.actor, w.viewer, c.req.param("id"), parsed.fields));
});

workflowBoardRoute.post("/:slug/workflow-board/deals/:id/move", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const move = moveBody(await body(c));
  if (!move) return c.json({ error: "from and to must be step ids." }, 400);
  return answerMove(c, await moveDeal(w.organization.id, w.organization.timezone, w.actor, w.viewer, c.req.param("id"), move.from, move.to));
});

workflowBoardRoute.post("/:slug/workflow-board/deals/:id/close", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const close = closeBody(await body(c));
  if (!close) return c.json({ error: "reason is required." }, 400);
  return answerClose(c, await closeDeal(w.organization.id, w.actor, w.viewer, c.req.param("id"), close.reason, close.note));
});

workflowBoardRoute.post("/:slug/workflow-board/deals/:id/units", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const raw = await body(c);
  if (typeof raw.unitId !== "string" || !raw.unitId) return c.json({ error: "unitId is required." }, 400);
  return answerCard(c, await linkUnit(w.organization.id, w.actor, w.viewer, c.req.param("id"), raw.unitId));
});

workflowBoardRoute.delete("/:slug/workflow-board/deals/:id/units/:unitId", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  return answerCard(c, await unlinkUnit(w.organization.id, w.actor, w.viewer, c.req.param("id"), c.req.param("unitId")));
});

// ---------------------------------------------------------------------------
// Portal listings (7 Nov 2026): a unit's photos, its publish switches, the
// business's portal settings and each agent's BRN.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §3, §5, §9
// ---------------------------------------------------------------------------

const NOT_JPEG = "Photos must be JPEG.";
const TOO_SMALL = "Too small for the portals: at least 800 × 600 pixels.";
const ADMINS_ONLY = "Only an admin can change portal settings.";

/** The business's own date, never the server's or the browser's. */
const todayIn = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());

workflowBoardRoute.post("/:slug/workflow-board/units/:id/photos", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const upload = await readBoardPhoto(c);
  if (!upload.ok) return c.json({ error: upload.error }, upload.status);
  if (!upload.file) return c.json({ error: "Add a photo." }, 400);
  if (upload.file.size > PHOTO_MAX_BYTES) return c.json({ error: PHOTO_TOO_LARGE }, 413);
  const bytes = new Uint8Array(await upload.file.arrayBuffer());
  const size = upload.file.type === "image/jpeg" ? jpegSize(bytes) : null;
  if (!size) return c.json({ error: NOT_JPEG }, 400);
  if (size.width < 800 || size.height < 600) return c.json({ error: TOO_SMALL }, 422);
  const result = await addUnitPhoto(w.organization.id, c.req.param("id"), { bytes, ...size }, w.actor);
  if (result === null) return c.json({ error: "Card not found" }, 404);
  if ("refused" in result) return c.json({ error: result.refused }, 422);
  return followOnPortals(c.json({ id: result.id, ...size }, 201), w.organization.id, c.req.param("id"));
});

workflowBoardRoute.get("/:slug/workflow-board/units/:id/photos/:photoId", async (c) => {
  const { organization, answer } = await boardBusiness(c);
  if (!organization) return answer;
  const bytes = await unitPhotoBytes(organization.id, c.req.param("id"), c.req.param("photoId"));
  if (!bytes) return c.json({ error: "Photo not found" }, 404);
  return c.body(bytes, 200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/photos/order", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const ids = (await body(c)).ids;
  if (!Array.isArray(ids) || ids.length > 30 || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) {
    return c.json({ error: "ids must list the photos." }, 400);
  }
  const result = await orderUnitPhotos(w.organization.id, c.req.param("id"), ids as string[], w.actor);
  if (result === null) return c.json({ error: "Card not found" }, 404);
  if (result !== true) return c.json({ error: result.refused }, 422);
  return followOnPortals(c.json({ ok: true }), w.organization.id, c.req.param("id"));
});

workflowBoardRoute.delete("/:slug/workflow-board/units/:id/photos/:photoId", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const removed = await removeUnitPhoto(w.organization.id, c.req.param("id"), c.req.param("photoId"), w.actor);
  return removed
    ? followOnPortals(c.json({ ok: true }), w.organization.id, c.req.param("id"))
    : c.json({ error: "Photo not found" }, 404);
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/portals/:portal", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const portal = c.req.param("portal");
  if (!(PORTAL_TARGETS as readonly string[]).includes(portal)) return c.json({ error: "Unknown portal." }, 404);
  const wanted = (await body(c)).wanted;
  if (typeof wanted !== "boolean") return c.json({ error: "wanted must be true or false." }, 400);
  const result = await setUnitPortal(
    w.organization.id,
    c.req.param("id"),
    portal as PortalTarget,
    wanted,
    w.actor,
    w.viewer,
    todayIn(w.organization.timezone)
  );
  return followOnPortals(answerCard(c, result), w.organization.id, c.req.param("id"));
});

// Pocket listings (7 Nov 2026): a unit kept off-market, shared one buyer at a time.
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §4, §9

workflowBoardRoute.post("/:slug/workflow-board/units/:id/pocket", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const pocket = (await body(c)).pocket;
  if (typeof pocket !== "boolean") return c.json({ error: "pocket must be true or false." }, 400);
  const unitId = c.req.param("id");
  // Pocket on turns the portal switches off, so Property Finder and Bayut follow.
  return followOnPortals(answerCard(c, await setUnitPocket(w.organization.id, unitId, pocket, w.actor, w.viewer)), w.organization.id, unitId);
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/pocket/shares", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const dealId = (await body(c)).dealId;
  if (typeof dealId !== "string" || dealId.length === 0 || dealId.length > 64) return c.json({ error: "dealId is required." }, 400);
  const result = await createPocketShare(w.organization.id, c.req.param("id"), dealId, w.actor, w.viewer, todayIn(w.organization.timezone));
  if (result === null) return c.json({ error: "Card not found" }, 404);
  if (result === "closed") return c.json({ error: CLOSED }, 409);
  if ("refused" in result) return c.json({ error: result.refused }, 422);
  const url = `${appBaseUrl()}/pocket/${result.token}`;
  const message = pocketMessage({
    firstName: result.recipient.firstName,
    title: result.unit.title,
    community: result.unit.community,
    priceAed: result.unit.priceAed,
    url,
    agentFirstName: result.agentFirstName,
    businessName: w.organization.name,
  });
  return c.json({ share: result.share, url, message, whatsappUrl: whatsappLink(result.recipient.number, message) }, result.created ? 201 : 200);
});

workflowBoardRoute.delete("/:slug/workflow-board/units/:id/pocket/shares/:shareId", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const revoked = await revokePocketShare(w.organization.id, c.req.param("id"), c.req.param("shareId"));
  return revoked ? c.json({ ok: true }) : c.json({ error: "Link not found" }, 404);
});

/** Settings and licences are an admin's: the business, or the answer to send. */
async function adminBusiness(c: Context) {
  if (scopeOf(c).role !== "operator") return { answer: c.json({ error: ADMINS_ONLY }, 403), organization: undefined };
  return boardBusiness(c);
}

async function settingsView(organizationId: string) {
  const s = await portalSettings(organizationId);
  return {
    orn: s.orn,
    feedUrl: s.feedToken ? `${apiBaseUrl()}/portal-feeds/${s.feedToken}/bayut.xml` : null,
    lastReadAt: s.feedLastReadAt,
    lastReadBy: s.feedLastReadBy,
    agents: await portalAgents(organizationId),
    // Never the key or the secret: whether one is saved, its last four characters and the last check.
    propertyFinder: { ...(await pfConnectionView(organizationId)), listingCallsReady: PF_LISTING_CALLS_READY },
    // Never the token: as Property Finder's, with the account's Bayut users and the agent links.
    bayut: await bayutSettings(organizationId),
  };
}

const CHECKING = "Checking already — try again in a few seconds.";
const CHECK_EVERY_MS = 10_000;

/** One check per business every 10 seconds, so a double click does not send two — a gate for each portal. */
function oneCheckEvery10s(): (organizationId: string) => boolean {
  const last = new Map<string, number>();
  return (organizationId) => {
    const now = Date.now();
    const then = last.get(organizationId);
    if (then !== undefined && now - then < CHECK_EVERY_MS) return false;
    last.set(organizationId, now);
    return true;
  };
}

const PF_KEY_MISSING = "Enter the API key and secret.";
const PF_ENVIRONMENT = "Choose Sandbox or Live.";
const PF_NO_KEY = "No Property Finder key is saved.";
const PF_KEY_SHAPE = /^[\x21-\x7E]{1,200}$/;

/** The key, secret and environment from the admin's form, or the words to send back. */
function pfKeyInput(raw: Record<string, unknown>): { key: string; secret: string; environment: "sandbox" | "live" } | { error: string } {
  const key = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const secret = typeof raw.apiSecret === "string" ? raw.apiSecret.trim() : "";
  if (!PF_KEY_SHAPE.test(key) || !PF_KEY_SHAPE.test(secret)) return { error: PF_KEY_MISSING };
  if (raw.environment !== "sandbox" && raw.environment !== "live") return { error: PF_ENVIRONMENT };
  return { key, secret, environment: raw.environment };
}

/** One token request per business every 10 seconds. */
const mayCheckPf = oneCheckEvery10s();

/** What a check says, in the admin's words (null: the key works). */
function pfCheckError(answer: PfAnswer): string | null {
  if (answer.ok) return null;
  if (answer.kind === "unreachable") return `Could not reach Property Finder: ${answer.message}`;
  return `Property Finder refused the key: ${answer.message}`;
}

/** A key that works starts a cycle at once; never in the way of the answer. */
function syncPropertyFinderSoon(): void {
  void queuePfCycle().catch((err) =>
    console.error("[property-finder] could not queue a cycle:", err instanceof Error ? err.message : err)
  );
}

/** Digits, 1 to 10 of them; blank or null clears it; anything else is refused (undefined). */
function licence(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return null;
  return /^\d{1,10}$/.test(t) ? t : undefined;
}

workflowBoardRoute.get("/:slug/workflow-board/portal-settings", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  return c.json(await settingsView(organization.id));
});

workflowBoardRoute.patch("/:slug/workflow-board/portal-settings", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const orn = licence((await body(c)).orn);
  if (orn === undefined) return c.json({ error: "Invalid orn." }, 400);
  await setPortalOrn(organization.id, orn);
  return c.json(await settingsView(organization.id));
});

workflowBoardRoute.post("/:slug/workflow-board/portal-settings/feed", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  await newPortalFeed(organization.id);
  return c.json(await settingsView(organization.id));
});

// Property Finder's key (7 Nov 2026). Saved whatever the check says, with what
// it said, so a wrong secret can be corrected without retyping the key.
workflowBoardRoute.put("/:slug/workflow-board/portal-settings/property-finder", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const input = pfKeyInput(await body(c));
  if ("error" in input) return c.json({ error: input.error }, 400);
  if (!mayCheckPf(organization.id)) return c.json({ error: CHECKING }, 409);
  const checkError = pfCheckError(await pfClient.checkKey(input));
  await savePfConnection(organization.id, { ...input, checkError });
  if (!checkError) syncPropertyFinderSoon();
  return c.json(await settingsView(organization.id));
});

workflowBoardRoute.post("/:slug/workflow-board/portal-settings/property-finder/check", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const creds = await pfCredentials(organization.id);
  if (!creds) return c.json({ error: PF_NO_KEY }, 404);
  if (!mayCheckPf(organization.id)) return c.json({ error: CHECKING }, 409);
  const checkError = pfCheckError(await pfClient.checkKey(creds));
  await recordPfCheck(organization.id, checkError);
  if (!checkError) syncPropertyFinderSoon();
  return c.json(await settingsView(organization.id));
});

workflowBoardRoute.delete("/:slug/workflow-board/portal-settings/property-finder", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  await clearPfConnection(organization.id);
  return c.json(await settingsView(organization.id));
});

workflowBoardRoute.patch("/:slug/workflow-board/agents/:employeeId/brn", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const brn = licence((await body(c)).brn);
  if (brn === undefined) return c.json({ error: "Invalid brn." }, 400);
  const saved = await setEmployeeBrn(organization.id, c.req.param("employeeId"), brn);
  return saved ? c.json({ ok: true }) : c.json({ error: "Employee not found" }, 404);
});

// ---------------------------------------------------------------------------
// Bayut (23 Nov 2026): the business's Bayut API token, each agent's Bayut user,
// and the location search staff use on a card.
//
// THE TOKEN NEVER LEAVES THE SERVER: no answer, log line or error carries it.
// The settings show its last four characters; Bayut's own words have it blanked
// out (Bayut may echo the request — the client blanks it, and so does this file).
//
// A check is good only when Bayut names the agency the token belongs to (the
// first without a parent, else the first): the sync must never send to an
// account it cannot tell apart from the next. The token is saved whatever the
// check says, with what it said, so it can be checked again. The Bayut users a
// good check reads are kept in Redis a week, for the agent links; a read of
// them waits at most 1.5 s, so Portal settings answers while Redis is down
// (final review, 24 Nov 2026). The location
// search is cached a day for each business and search, and spends the same
// per-business call budget as the sync.
//
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §6, §12, §14
// ---------------------------------------------------------------------------

const BAYUT_TOKEN_MISSING = "Enter the Bayut API token.";
const BAYUT_NO_TOKEN = "No Bayut token is saved.";
const BAYUT_UNKNOWN_USER = "Unknown Bayut user.";
const BAYUT_SEARCH_SHORT = "Type at least 3 characters.";
const BAYUT_CONNECT_FIRST = "Connect Bayut first.";
const BAYUT_BUSY = "Bayut is busy — try again in a minute.";
const BAYUT_TOKEN_REFUSED = "Bayut refused the token — an admin can check it in Portal settings";
/** 1–500 printable characters, once trimmed. */
const BAYUT_TOKEN_SHAPE = /^[\x20-\x7E]{1,500}$/;
const BAYUT_USERS_FOR_S = 7 * 24 * 60 * 60;
const BAYUT_LOCATIONS_FOR_S = 24 * 60 * 60;
/** Bayut's own wait when a 429 does not say. */
const BAYUT_RETRY_AFTER_S = 60;
const BAYUT_DEEP_LEVELS = 4;

const mayCheckBayut = oneCheckEvery10s();

type BayutUser = { id: number; name: string; email: string | null };
type BayutFailure = Extract<BayutAnswer<unknown>, { ok: false }>;

const blanked = (message: string, token: string) => message.split(token).join("•••");

/**
 * How long a Bayut read from Redis may take (final review, 24 Nov 2026): the
 * connection queues commands while Redis is down (maxRetriesPerRequest null),
 * and Portal settings — the ORN, the BRNs, Property Finder — must still answer.
 */
const BAYUT_REDIS_READ_MS = 1_500;

/** A value kept in Redis; nothing when it is not there, Redis cannot say, or does not say within 1.5 s. */
async function keptForBayut(key: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BAYUT_REDIS_READ_MS);
  });
  try {
    const raw = await Promise.race([bayutRedis({}).get(key), late]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps a value in Redis for `seconds`; never in the way of the answer. */
async function keepForBayut(key: string, value: unknown, seconds: number): Promise<void> {
  try {
    await bayutRedis({}).set(key, JSON.stringify(value), "EX", seconds);
  } catch (err) {
    console.error("[bayut] could not keep what Bayut said:", err instanceof Error ? err.message : err);
  }
}

const isBayutUser = (u: unknown): u is BayutUser => {
  const x = u as Partial<BayutUser> | null;
  return typeof x === "object" && x !== null && typeof x.id === "number" && typeof x.name === "string" && (x.email === null || typeof x.email === "string");
};

/** The Bayut users the last good check read; none when unknown. */
async function keptBayutUsers(organizationId: string): Promise<BayutUser[]> {
  const list = await keptForBayut(bayutUsersKey(organizationId));
  return Array.isArray(list) ? list.filter(isBayutUser) : [];
}

/** Keeps the users a check read, for a week; none forgets them. */
const keepBayutUsers = (organizationId: string, users: BayutUser[]) =>
  keepForBayut(bayutUsersKey(organizationId), users.map(({ id, name, email }) => ({ id, name, email })), BAYUT_USERS_FOR_S);

/** What Portal settings shows of Bayut: never the token. */
async function bayutSettings(organizationId: string) {
  const view = await bayutConnectionView(organizationId);
  const users = view.saved ? await keptBayutUsers(organizationId) : [];
  const links = (await bayutAgentLinks(organizationId)).map(({ employeeId, bayutUserId }) => ({ employeeId, bayutUserId }));
  return { ...view, users, links };
}

/** Asks Bayut which agency the token belongs to; good only when Bayut names one (the words: `bayut-check.ts`). */
async function checkBayut(token: string): Promise<BayutCheck> {
  return bayutCheckOf(await bayutClient.agencies(token), token);
}

/**
 * A check, then `record` (a save or a check again): a good check also reads the
 * account's Bayut users — kept, and matched to staff by email after the record,
 * which clears another account's links — and starts a cycle at once. A users
 * read that fails fails nothing; another account whose users could not be read
 * forgets the old account's. Whether the account changed.
 */
async function checkAndRecord(
  organizationId: string,
  token: string,
  record: (check: BayutCheck) => Promise<{ accountChanged: boolean }>
): Promise<boolean> {
  const check = await checkBayut(token);
  const users = check.agencyId === null ? null : await bayutClient.users(token, check.agencyId);
  const { accountChanged } = await record(check);
  if (users?.ok) {
    await keepBayutUsers(organizationId, users.data);
    await autoLinkBayutAgents(organizationId, users.data);
  } else if (accountChanged) {
    await keepBayutUsers(organizationId, []);
  }
  if (check.checkError === null) {
    void queueBayutCycle().catch((err) => console.error("[bayut] could not queue a cycle:", err instanceof Error ? err.message : err));
  }
  return accountChanged;
}

workflowBoardRoute.put("/:slug/workflow-board/portal-settings/bayut", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const given = (await body(c)).token;
  const token = typeof given === "string" ? given.trim() : "";
  if (!BAYUT_TOKEN_SHAPE.test(token)) return c.json({ error: BAYUT_TOKEN_MISSING }, 400);
  if (!mayCheckBayut(organization.id)) return c.json({ error: CHECKING }, 409);
  const accountChanged = await checkAndRecord(organization.id, token, (check) => saveBayutConnection(organization.id, { token, ...check }));
  return c.json({ ...(await settingsView(organization.id)), accountChanged });
});

workflowBoardRoute.post("/:slug/workflow-board/portal-settings/bayut/check", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const saved = await bayutToken(organization.id);
  if (!saved) return c.json({ error: BAYUT_NO_TOKEN }, 404);
  if (!mayCheckBayut(organization.id)) return c.json({ error: CHECKING }, 409);
  const accountChanged = await checkAndRecord(organization.id, saved.token, (check) => recordBayutCheck(organization.id, check));
  return c.json({ ...(await settingsView(organization.id)), accountChanged });
});

// Listings already on Bayut stay there until removed in Profolio.
workflowBoardRoute.delete("/:slug/workflow-board/portal-settings/bayut", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  await clearBayutConnection(organization.id);
  await keepBayutUsers(organization.id, []);
  return c.json(await settingsView(organization.id));
});

// An agent's Bayut user, from those read at the last check; null unlinks them.
workflowBoardRoute.put("/:slug/workflow-board/portal-settings/bayut/agents/:employeeId", async (c) => {
  const { organization, answer } = await adminBusiness(c);
  if (!organization) return answer;
  const wanted = (await body(c)).bayutUserId;
  let link: { bayutUserId: number; bayutUserName: string | null } | null = null;
  if (wanted !== null) {
    const user = (await keptBayutUsers(organization.id)).find((u) => u.id === wanted);
    if (!user) return c.json({ error: BAYUT_UNKNOWN_USER }, 400);
    link = { bayutUserId: user.id, bayutUserName: user.name || null };
  }
  const linked = await linkBayutAgent(organization.id, c.req.param("employeeId"), link);
  return linked ? c.json(await settingsView(organization.id)) : c.json({ error: "Employee not found" }, 404);
});

/** What a failed search says. Bayut's 409 and 429 are "busy"; a 429 also pauses the business, as the sync does. */
function bayutSearchError(answer: BayutFailure, token: string): { error: string; status: 429 | 502 } {
  if (answer.kind === "rate-limited" || answer.kind === "busy") return { error: BAYUT_BUSY, status: 429 };
  if (answer.kind === "token-refused") return { error: BAYUT_TOKEN_REFUSED, status: 502 };
  if (answer.kind === "refused") return { error: `Bayut refused the search: ${blanked(answer.message, token)}`, status: 502 };
  return { error: `Could not reach Bayut: ${blanked(answer.message, token)}`, status: 502 };
}

/**
 * Staff search Bayut's locations for a card (3+ characters; `city` is the
 * unit's, blank being Dubai). Only deep locations are offered — Bayut refuses a
 * listing placed on an area or an emirate — named by their breadcrumb.
 */
workflowBoardRoute.get("/:slug/workflow-board/bayut/locations", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const organizationId = w.organization.id;
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  if (q.length < 3) return c.json({ error: BAYUT_SEARCH_SHORT }, 400);
  const city = (c.req.query("city") ?? "").trim().slice(0, 100) || "Dubai";
  const view = await bayutConnectionView(organizationId);
  const saved = view.saved && view.checkedAt !== null && view.checkError === null ? await bayutToken(organizationId) : null;
  if (!saved) return c.json({ error: BAYUT_CONNECT_FIRST }, 409);
  const key = `bayut-locations:${organizationId}:${city.toLowerCase()}:${q.toLowerCase()}`;
  const cached = await keptForBayut(key);
  if (Array.isArray(cached)) return c.json(cached);
  if ((await bayutPaused(organizationId)) || !(await takeBayutCalls(organizationId, 1))) return c.json({ error: BAYUT_BUSY }, 429);
  const answer = await bayutClient.locations(saved.token, q, city);
  if (!answer.ok) {
    if (answer.kind === "rate-limited") await pauseBayut(organizationId, answer.retryAfter ?? BAYUT_RETRY_AFTER_S);
    const failed = bayutSearchError(answer, saved.token);
    return c.json({ error: failed.error }, failed.status);
  }
  const found = answer.data
    .filter((l) => l.breadcrumb.length >= BAYUT_DEEP_LEVELS)
    .map((l) => ({ id: l.id, name: l.breadcrumb.join(" › ").slice(0, 300) }));
  await keepForBayut(key, found, BAYUT_LOCATIONS_FOR_S);
  return c.json(found);
});
