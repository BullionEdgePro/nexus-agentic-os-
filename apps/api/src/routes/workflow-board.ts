import { Hono, type Context } from "hono";
import {
  addUnitPhoto,
  cardHistory,
  clearPfConnection,
  closeDeal,
  createPocketShare,
  closeUnit,
  createDeal,
  createUnit,
  findOrganizationBySlug,
  getBoard,
  linkUnit,
  moveDeal,
  moveUnit,
  newPortalFeed,
  orderUnitPhotos,
  pfConnectionView,
  pfCredentials,
  portalAgents,
  portalSettings,
  recordPfCheck,
  removeUnitPhoto,
  revokePocketShare,
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
import { PHOTO_MAX_BYTES, PHOTO_TOO_LARGE, readBoardPhoto } from "../lib/board-photo-upload.js";
import { jpegSize } from "../lib/jpeg-size.js";
import { pfClient, type PfAnswer } from "../lib/property-finder.js";
import { apiBaseUrl, appBaseUrl } from "../lib/public-urls.js";
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

/** A card, or one of the module's other answers, as a response. */
/**
 * Property Finder follows a unit half a minute after a write to it succeeds
 * (7 Nov 2026) — listing details, photos, the switch, a move or a close all
 * change what should be on Property Finder. Never in the way of the write: when
 * Redis is down the ten-minute cycle picks the change up.
 */
function followOnPropertyFinder(res: Response, organizationId: string, unitId: string): Response {
  if (res.status >= 200 && res.status < 300) {
    void queuePfUnit(organizationId, unitId).catch((err) =>
      console.error("[property-finder] could not queue the unit:", err instanceof Error ? err.message : err)
    );
  }
  return res;
}

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
  const parsed = parseUnitFields(await body(c));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const unitId = c.req.param("id");
  return followOnPropertyFinder(answerCard(c, await updateUnit(w.organization.id, w.actor, w.viewer, unitId, parsed.fields)), w.organization.id, unitId);
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/move", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const move = moveBody(await body(c));
  if (!move) return c.json({ error: "from and to must be step ids." }, 400);
  const unitId = c.req.param("id");
  return followOnPropertyFinder(
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
  return followOnPropertyFinder(
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
  return followOnPropertyFinder(c.json({ id: result.id, ...size }, 201), w.organization.id, c.req.param("id"));
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
  return followOnPropertyFinder(c.json({ ok: true }), w.organization.id, c.req.param("id"));
});

workflowBoardRoute.delete("/:slug/workflow-board/units/:id/photos/:photoId", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const removed = await removeUnitPhoto(w.organization.id, c.req.param("id"), c.req.param("photoId"), w.actor);
  return removed
    ? followOnPropertyFinder(c.json({ ok: true }), w.organization.id, c.req.param("id"))
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
  return followOnPropertyFinder(answerCard(c, result), w.organization.id, c.req.param("id"));
});

// Pocket listings (7 Nov 2026): a unit kept off-market, shared one buyer at a time.
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §4, §9

workflowBoardRoute.post("/:slug/workflow-board/units/:id/pocket", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const pocket = (await body(c)).pocket;
  if (typeof pocket !== "boolean") return c.json({ error: "pocket must be true or false." }, 400);
  const unitId = c.req.param("id");
  // Pocket on turns the portal switches off, so Property Finder follows.
  return followOnPropertyFinder(answerCard(c, await setUnitPocket(w.organization.id, unitId, pocket, w.actor, w.viewer)), w.organization.id, unitId);
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
  };
}

const PF_KEY_MISSING = "Enter the API key and secret.";
const PF_ENVIRONMENT = "Choose Sandbox or Live.";
const PF_NO_KEY = "No Property Finder key is saved.";
const PF_CHECKING = "Checking already — try again in a few seconds.";
const PF_KEY_SHAPE = /^[\x21-\x7E]{1,200}$/;
const PF_CHECK_EVERY_MS = 10_000;

/** The key, secret and environment from the admin's form, or the words to send back. */
function pfKeyInput(raw: Record<string, unknown>): { key: string; secret: string; environment: "sandbox" | "live" } | { error: string } {
  const key = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const secret = typeof raw.apiSecret === "string" ? raw.apiSecret.trim() : "";
  if (!PF_KEY_SHAPE.test(key) || !PF_KEY_SHAPE.test(secret)) return { error: PF_KEY_MISSING };
  if (raw.environment !== "sandbox" && raw.environment !== "live") return { error: PF_ENVIRONMENT };
  return { key, secret, environment: raw.environment };
}

/** One token request per business every 10 seconds, so a double click does not send two. */
const lastPfCheck = new Map<string, number>();
function mayCheckPf(organizationId: string): boolean {
  const now = Date.now();
  const last = lastPfCheck.get(organizationId);
  if (last !== undefined && now - last < PF_CHECK_EVERY_MS) return false;
  lastPfCheck.set(organizationId, now);
  return true;
}

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
  if (!mayCheckPf(organization.id)) return c.json({ error: PF_CHECKING }, 409);
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
  if (!mayCheckPf(organization.id)) return c.json({ error: PF_CHECKING }, 409);
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
