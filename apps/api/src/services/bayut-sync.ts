import { createHash } from "node:crypto";
import {
  BAYUT_PORTALS,
  bayutNextSteps,
  matchAmenities,
  toBayutListing,
  type Amenity,
  type BayutListingBody,
  type BayutPortal,
  type BayutRemote,
  type BayutState,
  type BayutStep,
  type PortalListing,
} from "@nexus/shared";
import { bayutBusinesses, bayutListings, bayutTakenOff, bayutToken, bayutUnitsToSync, recordBayutCheck, recordBayutStep } from "@nexus/db";
import type { BayutAnswer, BayutClient } from "../lib/bayut.js";
import { bayutBudget, bayutRedis, type BayutRedis, type Budget } from "../lib/bayut-budget.js";
import { apiBaseUrl } from "../lib/public-urls.js";
import { logger } from "../lib/logger.js";

/**
 * The Bayut sync (23 Nov 2026): for every business with a checked token, the
 * units wanted on Bayut or dubizzle, or still held there, are kept in step with
 * "wanted AND ready", and Bayut's answers are written on each portal's row.
 *
 * The order is compliance first, so a spent call budget never holds back a
 * take-down: (1) removals, (2) creates, updates and publishes, oldest answer
 * first, (3) Bayut's state list, and the permit check of each pending unit,
 * (4) Bayut's rejected list. A unit's own job, half a minute after it changed,
 * runs (1) and (2) for that unit only.
 *
 * Credits are spent only when staff ask:
 * - the ref is written on both portal rows the moment Bayut gives it, before
 *   any publish, so a listing is never created twice;
 * - a publish is asked once (pending) and waited for, and a portal is never
 *   published twice in 24 hours — counted from the publish ASKED, so one whose
 *   answer was lost on the way is not asked again for a day;
 * - a refusal remembers what was refused and waits for the listing to change,
 *   also before Bayut ever took it (rule 3 for a listing with no ref yet);
 * - a failed update never marks a live or pending portal failed or refused:
 *   it is still advertised, and either word would let it be published again;
 * - a portal Bayut took down that Nexus held live or pending, still wanted and
 *   ready, has its switch turned off with the date (rule 9) — never one whose
 *   publish was asked in this same run, which Bayut has not had time to act on;
 * - the rejected list never marks refused a portal the state list showed
 *   active in this run: Bayut's word that it is live wins.
 *
 * Bayut's state list is read for what it says about each portal: active is
 * live, whatever Nexus held; inactive ends a live, pending or draft portal;
 * draft keeps a pending one pending. Nexus's own record of a removal, a
 * refusal or a failed attempt is never overwritten by inactive or draft.
 *
 * At most 40 Bayut calls a minute for each business (`bayut-budget.ts`): when
 * spent, that business stops for this run and the next one goes on. A 429
 * pauses that business for Bayut's retry_after; a 409 leaves the unit for the
 * next run, writing nothing; a refused token is recorded on the business's
 * settings and stops it. One unit's failure never stops the next, and one
 * business's never stops another's. The token never appears in a log line.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §1, §9, §10, §11
 */

type Options = {
  client: BayutClient;
  budget?: Budget;
  now?: () => Date;
  /** Where Bayut's amenity ids are kept for a day (and the budget's counts, when no budget is given). */
  redis?: BayutRedis;
};

type AmenityIds = Partial<Record<Amenity, string>>;
type Wanted = { listing: PortalListing; portals: BayutPortal[]; userId: number; locationId: number };
type Unit = { unitId: string; held: BayutRemote; stopped: boolean };
type Run = {
  organizationId: string;
  timezone: string;
  token: string;
  agencyId: number;
  client: BayutClient;
  budget: Budget;
  redis: () => BayutRedis;
  now: Date;
  amenityIds: AmenityIds | null;
  /** `<unitId> <portal>` published in this run, or shown active by this run's state list. */
  asked: Set<string>;
  active: Set<string>;
  done: { steps: number; failed: number };
};
type Write = { state: BayutState; message: string | null; fingerprint?: string; publishedAt?: Date; permitComment?: string | null };

const AMENITIES_KEPT_SECONDS = 24 * 60 * 60;
const DEFAULT_RETRY_AFTER = 60;
/** 10,000 listings: a bound on the state list even when the budget cannot count (Redis down). */
const MAX_PAGES = 100;

/** A stable fingerprint of the body as it would be sent, keys sorted (as `pfFingerprint`). */
export function bayutFingerprint(body: BayutListingBody): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const todayIn = (timezone: string, at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
/** "21 Nov": the business's own date, as the card shows it. */
const dayMonthIn = (timezone: string, at: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: timezone }).format(at);
const photoUrl = (photoId: string) => `${apiBaseUrl()}/portal-photos/${photoId}.jpg`;
const at = (unit: Unit, portal: BayutPortal) => `${unit.unitId} ${portal}`;
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Bayut refused the token: the business stops, and its settings say so. */
class TokenRefused extends Error {}
/** The call budget is spent, or Bayut asked Nexus to wait: the business stops for this run. */
class Stop extends Error {}

/** Every business with a checked token and a known agency. */
export async function runBayutCycle(opts: Options): Promise<{ businesses: number; steps: number; failed: number }> {
  const result = { businesses: 0, steps: 0, failed: 0 };
  for (const business of await bayutBusinesses()) {
    result.businesses += 1;
    try {
      const done = await syncBusiness(business, opts, null);
      result.steps += done.steps;
      result.failed += done.failed;
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { organizationId: business.organizationId, err: why(err) },
        "Bayut sync failed for this business — the others go on, and it is tried again next cycle"
      );
    }
  }
  return result;
}

/** One unit, soon after it changed: its removals, then its sends. Does nothing when the business is not synced. */
export async function runBayutUnit(organizationId: string, unitId: string, opts: Options): Promise<void> {
  const business = (await bayutBusinesses()).find((b) => b.organizationId === organizationId);
  if (!business) return;
  await syncBusiness(business, opts, unitId);
}

async function syncBusiness(
  business: { organizationId: string; timezone: string },
  opts: Options,
  onlyUnit: string | null
): Promise<{ steps: number; failed: number }> {
  const { organizationId, timezone } = business;
  const held = await bayutToken(organizationId);
  if (!held || held.agencyId === null) return { steps: 0, failed: 0 };
  const budget = opts.budget ?? bayutBudget({ redis: opts.redis, now: opts.now });
  if (await budget.paused(organizationId)) return { steps: 0, failed: 0 };
  const now = opts.now?.() ?? new Date();
  const run: Run = {
    organizationId,
    timezone,
    token: held.token,
    agencyId: held.agencyId,
    client: opts.client,
    budget,
    redis: () => bayutRedis({ redis: opts.redis }),
    now,
    amenityIds: null,
    asked: new Set(),
    active: new Set(),
    done: { steps: 0, failed: 0 },
  };
  try {
    const units: Unit[] = (await bayutUnitsToSync(organizationId))
      .filter((u) => !onlyUnit || u.unitId === onlyUnit)
      .map((u) => ({ unitId: u.unitId, held: structuredClone(u.remote), stopped: false }));
    if (units.length === 0) return run.done;
    const wanted = new Map((await bayutListings(organizationId, todayIn(timezone, now), photoUrl)).map((w) => [w.listing.reference, w]));
    await removals(run, units, wanted);
    await sends(run, units, wanted);
    if (onlyUnit) return run.done;
    const onBayut = units.filter((u) => u.held.ref);
    if (onBayut.length === 0) return run.done;
    await states(run, onBayut, wanted);
    await permitChecks(run, onBayut);
    await rejections(run, onBayut);
  } catch (err) {
    if (err instanceof TokenRefused) {
      await recordBayutCheck(organizationId, { checkError: `Bayut refused the token: ${err.message}`, agencyId: null, agencyName: null });
      logger.warn({ organizationId }, "Bayut refused the token — this business's sync stops until an admin checks it");
    } else if (err instanceof Stop) {
      logger.info({ organizationId, why: err.message }, "Bayut sync stopped for this business — the next run goes on");
    } else {
      throw err;
    }
  }
  return run.done;
}

/**
 * One Bayut call, counted against the budget. A refused token and a 429 stop
 * the business (the 429 pauses it first); every other answer is the caller's.
 */
async function ask<T>(run: Run, call: (client: BayutClient, token: string) => Promise<BayutAnswer<T>>): Promise<BayutAnswer<T>> {
  if (!(await run.budget.take(run.organizationId, 1))) throw new Stop("the call budget for this minute is spent");
  const answer = await call(run.client, run.token);
  if (answer.ok) return answer;
  if (answer.kind === "token-refused") throw new TokenRefused(answer.message);
  if (answer.kind === "rate-limited") {
    await run.budget.pause(run.organizationId, answer.retryAfter ?? DEFAULT_RETRY_AFTER);
    throw new Stop("Bayut asked Nexus to wait (429)");
  }
  return answer;
}

/** One unit's work; its failure is counted and stops its later steps, never the next unit's. */
async function each(run: Run, unit: Unit, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof TokenRefused || err instanceof Stop) throw err;
    unit.stopped = true;
    run.done.failed += 1;
    logger.warn(
      { organizationId: run.organizationId, unitId: unit.unitId, err: why(err) },
      "A Bayut step failed — the unit is tried again next run"
    );
  }
}

/** Bayut's answer on one portal's row, with the unit's ref, and kept in step in memory. */
async function record(run: Run, unit: Unit, portal: BayutPortal, w: Write): Promise<void> {
  await recordBayutStep(run.organizationId, unit.unitId, portal, { ...(unit.held.ref ? { ref: unit.held.ref } : {}), ...w });
  const before = unit.held.portals[portal];
  unit.held.portals[portal] = { state: w.state, publishedAt: w.publishedAt ? w.publishedAt.toISOString() : before.publishedAt };
  if (w.fingerprint) unit.held.fingerprint = w.fingerprint;
}

/** (1) Whatever Bayut may still advertise, or is checking, that should not be live comes off first. */
async function removals(run: Run, units: Unit[], wanted: Map<string, Wanted>): Promise<void> {
  for (const unit of units) {
    if (!unit.held.ref) continue;
    const should = { portals: wanted.get(unit.unitId)?.portals ?? [], fingerprint: null };
    for (const step of bayutNextSteps(should, unit.held, run.now)) {
      if (step.kind !== "remove") continue;
      await each(run, unit, async () => {
        if (!(await remove(run, unit, step.portals))) unit.stopped = true;
      });
    }
  }
}

/** (2) The rule for every unit wanted and ready, in the order Bayut last answered. */
async function sends(run: Run, units: Unit[], wanted: Map<string, Wanted>): Promise<void> {
  for (const unit of units) {
    const want = wanted.get(unit.unitId);
    if (unit.stopped || !want) continue;
    await each(run, unit, async () => {
      const body = toBayutListing(want.listing, { userId: want.userId, locationId: want.locationId, amenityIds: await amenities(run) });
      const fingerprint = bayutFingerprint(body);
      const { held } = unit;
      // Rule 3 before Bayut ever took it: a refused listing is not created again until it changes.
      const refusedAsIs = !held.ref && held.fingerprint === fingerprint && want.portals.some((p) => held.portals[p].state === "refused");
      if (refusedAsIs) return;
      const steps = bayutNextSteps({ portals: want.portals, fingerprint }, held, run.now).filter((s) => s.kind !== "remove");
      for (const step of steps) {
        if (!(await send(run, unit, step, want.portals, body, fingerprint))) {
          unit.stopped = true;
          return;
        }
      }
    });
  }
}

/** Bayut's amenity ids, read once a day for each business; none this run when Bayut cannot say. */
async function amenities(run: Run): Promise<AmenityIds> {
  if (run.amenityIds) return run.amenityIds;
  const key = `bayut-amenities:${run.organizationId}`;
  try {
    const kept = await run.redis().get(key);
    if (kept) return (run.amenityIds = JSON.parse(kept) as AmenityIds);
  } catch (err) {
    logger.warn({ organizationId: run.organizationId, err: why(err) }, "Could not read Bayut's amenity ids from Redis");
  }
  const a = await ask(run, (c, t) => c.amenities(t));
  // A listing is never held back for its amenities: without them it is sent without them.
  if (!a.ok) return (run.amenityIds = {});
  const ids = matchAmenities(a.data);
  try {
    await run.redis().set(key, JSON.stringify(ids), "EX", AMENITIES_KEPT_SECONDS);
  } catch (err) {
    logger.warn({ organizationId: run.organizationId, err: why(err) }, "Could not keep Bayut's amenity ids in Redis");
  }
  return (run.amenityIds = ids);
}

/** True when the unit may go on to its next step. */
async function remove(run: Run, unit: Unit, portals: BayutPortal[]): Promise<boolean> {
  const a = await ask(run, (c, t) => c.remove(t, unit.held.ref!, portals));
  run.done.steps += 1;
  if (a.ok) {
    for (const p of portals) await record(run, unit, p, { state: "unpublished", message: null });
    return true;
  }
  if (a.kind === "busy") return false;
  // Still on Bayut: the state is kept, with Bayut's words, so the next run tries again.
  for (const p of portals) await record(run, unit, p, { state: unit.held.portals[p].state ?? "live", message: a.message });
  return false;
}

/** True when the unit may go on to its next step. */
async function send(
  run: Run,
  unit: Unit,
  step: Exclude<BayutStep, { kind: "remove" }>,
  wantedPortals: BayutPortal[],
  body: BayutListingBody,
  fingerprint: string
): Promise<boolean> {
  const { held } = unit;
  if (step.kind === "create") {
    const a = await ask(run, (c, t) => c.create(t, body));
    run.done.steps += 1;
    if (a.ok) {
      // Written on both rows the moment Bayut gives it, before any publish: never created twice.
      held.ref = a.data.id;
      for (const p of BAYUT_PORTALS) {
        await record(run, unit, p, { state: wantedPortals.includes(p) ? "draft" : "unpublished", message: null, fingerprint });
      }
      return true;
    }
    if (a.kind === "busy") return false;
    const refused = a.kind === "refused";
    for (const p of wantedPortals) {
      await record(run, unit, p, { state: refused ? "refused" : "failed", message: a.message, ...(refused ? { fingerprint } : {}) });
    }
    return false;
  }

  if (step.kind === "update") {
    const a = await ask(run, (c, t) => c.update(t, held.ref!, body));
    run.done.steps += 1;
    if (a.ok) {
      // Both rows hold what was sent. A refusal of the old listing no longer stands: it may be published.
      for (const p of BAYUT_PORTALS) {
        const s = held.portals[p].state;
        await record(run, unit, p, { state: s === null || s === "refused" ? "unpublished" : s, message: null, fingerprint });
      }
      return true;
    }
    if (a.kind === "busy") return false;
    const refused = a.kind === "refused";
    for (const p of BAYUT_PORTALS) {
      const { state, publishedAt } = held.portals[p];
      if (wantedPortals.includes(p)) {
        // Still advertised (or waiting on Bayut): the state stays, so it is never published again for this.
        const advertised = state === "live" || state === "pending" || (state === "draft" && publishedAt !== null);
        const next: BayutState = advertised && state ? state : refused ? "refused" : "failed";
        await record(run, unit, p, { state: next, message: a.message, ...(refused ? { fingerprint } : {}) });
      } else if (refused) {
        // Both rows remember what was refused, so it waits for a change.
        await record(run, unit, p, { state: state ?? "unpublished", message: null, fingerprint });
      }
    }
    return false;
  }

  // publish
  const a = await ask(run, (c, t) => c.publish(t, held.ref!, step.portals));
  run.done.steps += 1;
  if (a.ok) {
    for (const p of step.portals) {
      await record(run, unit, p, { state: "pending", message: null, publishedAt: run.now });
      run.asked.add(at(unit, p));
    }
    return true;
  }
  if (a.kind === "busy") return false;
  for (const p of step.portals) {
    // A publish that may have reached Bayut counts for the 24-hour guard; a refused one does not.
    await record(
      run,
      unit,
      p,
      a.kind === "refused" ? { state: "refused", message: a.message, fingerprint } : { state: "failed", message: a.message, publishedAt: run.now }
    );
  }
  return false;
}

/** (3) Bayut's state list, one call per 100 listings, read for the units Nexus holds a ref for. */
async function states(run: Run, units: Unit[], wanted: Map<string, Wanted>): Promise<void> {
  const seen = new Map<string, { name: string; state: string }[]>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const a = await ask(run, (c, t) => c.list(t, run.agencyId, page));
    if (!a.ok) break; // what was read is used; the rest waits for the next cycle
    for (const item of a.data.items) seen.set(item.id, item.portals);
    if (!a.data.next) break;
  }
  for (const unit of units) {
    const portals = seen.get(unit.held.ref!);
    if (!portals) continue; // missing from Bayut's answer: left as it is
    await each(run, unit, async () => {
      for (const p of BAYUT_PORTALS) {
        const theirs = portals.find((x) => x.name === p)?.state;
        if (theirs) await readState(run, unit, p, theirs, wanted.get(unit.unitId)?.portals.includes(p) ?? false);
      }
    });
  }
}

async function readState(run: Run, unit: Unit, p: BayutPortal, theirs: string, stillWanted: boolean): Promise<void> {
  const { state, publishedAt } = unit.held.portals[p];
  if (theirs === "active") {
    run.active.add(at(unit, p));
    await record(run, unit, p, { state: "live", message: null });
    return;
  }
  if (theirs === "inactive") {
    if (state === "live" || state === "pending") {
      if (run.asked.has(at(unit, p))) return; // asked moments ago: Bayut has not acted on it yet
      if (stillWanted) {
        // Rule 9: Bayut took it down. The switch goes off; staff decide whether to spend the credits again.
        await bayutTakenOff(run.organizationId, unit.unitId, p, dayMonthIn(run.timezone, run.now));
        unit.held.portals[p] = { state: "unpublished", publishedAt };
        return;
      }
      await record(run, unit, p, { state: "unpublished", message: null });
      return;
    }
    if (state === "draft" || state === null) await record(run, unit, p, { state: "unpublished", message: null });
    return;
  }
  if (theirs === "draft") {
    // A publish asked and not yet acted on stays pending (rule 7).
    if (state === "live") await record(run, unit, p, { state: publishedAt ? "pending" : "draft", message: null });
    else if (state === null) await record(run, unit, p, { state: "draft", message: null });
  }
  // Any other word from Bayut: left as it is.
}

/** (3) Once a cycle, the permit check of each pending unit, for the card. */
async function permitChecks(run: Run, units: Unit[]): Promise<void> {
  for (const unit of units) {
    const pending = BAYUT_PORTALS.filter((p) => unit.held.portals[p].state === "pending");
    if (pending.length === 0) continue;
    await each(run, unit, async () => {
      const a = await ask(run, (c, t) => c.show(t, unit.held.ref!));
      if (!a.ok || !a.data.permit) return;
      const permitComment = a.data.permit.comment ?? a.data.permit.status;
      for (const p of pending) await record(run, unit, p, { state: "pending", message: null, permitComment });
    });
  }
}

/** (4) Bayut's rejected list: the listings Nexus made become refused with Bayut's reason. */
async function rejections(run: Run, units: Unit[]): Promise<void> {
  const a = await ask(run, (c, t) => c.rejected(t));
  if (!a.ok) return;
  for (const rejection of a.data) {
    for (const unit of units.filter((u) => u.held.ref === rejection.id)) {
      await each(run, unit, async () => {
        for (const p of BAYUT_PORTALS) {
          const s = unit.held.portals[p].state;
          if (s !== "pending" && s !== "draft" && s !== "live") continue;
          if (run.asked.has(at(unit, p)) || run.active.has(at(unit, p))) continue;
          await record(run, unit, p, { state: "refused", message: rejection.reason || null });
        }
      });
    }
  }
}
