import { Hono, type Context } from "hono";
import {
  cardHistory,
  closeDeal,
  closeUnit,
  createDeal,
  createUnit,
  findOrganizationBySlug,
  getBoard,
  linkUnit,
  moveDeal,
  moveUnit,
  unlinkUnit,
  updateDeal,
  updateUnit,
  type Actor,
  type DealFields,
  type UnitFields,
  type Viewer,
} from "@nexus/db";
import { PORTALS, PROPERTY_TYPES, REAL_ESTATE_WORKFLOW, workflowFor } from "@nexus/shared";
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
  return answerCard(c, await updateUnit(w.organization.id, w.actor, w.viewer, c.req.param("id"), parsed.fields));
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/move", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const move = moveBody(await body(c));
  if (!move) return c.json({ error: "from and to must be step ids." }, 400);
  return answerMove(c, await moveUnit(w.organization.id, w.organization.timezone, w.actor, w.viewer, c.req.param("id"), move.from, move.to));
});

workflowBoardRoute.post("/:slug/workflow-board/units/:id/close", async (c) => {
  const w = await writer(c);
  if (!w.organization) return w.answer;
  const close = closeBody(await body(c));
  if (!close) return c.json({ error: "reason is required." }, 400);
  return answerClose(c, await closeUnit(w.organization.id, w.actor, w.viewer, c.req.param("id"), close.reason, close.note));
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
