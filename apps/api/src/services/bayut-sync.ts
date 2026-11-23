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
import {
  bayutBusinesses,
  bayutBusinessesToCheckAgain,
  bayutListings,
  bayutPublishAsked,
  bayutTakenOff,
  bayutToken,
  bayutUnitsHeld,
  bayutUnitsToSync,
  recordBayutCheck,
  recordBayutStep,
} from "@nexus/db";
import type { BayutAnswer, BayutClient } from "../lib/bayut.js";
import { bayutBudget, bayutRedis, type BayutRedis, type Budget } from "../lib/bayut-budget.js";
import { bayutCheckOf, bayutUsersKey } from "../lib/bayut-check.js";
import { apiBaseUrl } from "../lib/public-urls.js";
import { logger } from "../lib/logger.js";

/**
 * The Bayut sync (23 Nov 2026): for every business with a checked token, the
 * units wanted on Bayut or dubizzle, or still held there, are kept in step with
 * "wanted AND ready", and Bayut's answers are written on each portal's row.
 *
 * The order is compliance first, so a spent call budget never holds back a
 * take-down: (1) removals, (2) creates, updates and publishes, oldest answer
 * first, (3) Bayut's state list, read for EVERY unit Nexus holds a ref for
 * (whatever its state, so a listing Bayut makes live after Nexus stopped
 * expecting it is seen, and then taken off by rule 1), (4) Bayut's rejected
 * list — one call, asked before (5) so the per-unit calls never starve it —
 * and (5) the permit check of pending units, at most 10 a cycle, the longest
 * waiting first. A unit's own job, half a minute after it changed, runs (1)
 * and (2) for that unit only.
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
 *   it is still advertised, and either word would let it be published again.
 *   A refused one keeps Bayut's words (the card says the last change was
 *   refused); one that could not reach Bayut writes nothing and is sent again;
 * - a portal Bayut took down, still wanted and ready, has its switch turned
 *   off with the date (rule 9) — but only a live one, or a pending one whose
 *   publish is more than a day old: Bayut's list can still show the old state
 *   for a while after a publish;
 * - the time a publish is asked is written just before it is sent, so a worker
 *   stopped in the middle of the call never publishes it again; it is put back
 *   when Bayut answers that it did not take it (refused, busy, 429, token);
 * - the rejected list never marks refused a portal the state list showed
 *   active in this run: Bayut's word that it is live wins. Nor a live one
 *   unless this run read Bayut's whole state list, nor with a rejection dated
 *   before the portal's last publish: Bayut's first page keeps old rejections,
 *   and a listing staff fixed and published again is being checked anew. An
 *   undated rejection applies only to a portal never published;
 * - with no amenity map ever read for the business, no listing is created or
 *   updated: sent without amenities, then with them, each live listing would
 *   be sent twice, and a refused one would look changed when nobody changed
 *   it. A failed read falls back to the last good map, kept with no expiry.
 *
 * Every write lands only while the business is still on the run's Bayut
 * account (`recordBayutStep`): a token replaced by another account's mid-run
 * clears the rows, and the run stops at its first write that lands nowhere,
 * so it neither writes the old account's ids back nor sends anything more.
 *
 * Bayut's state list is read for what it says about each portal: active is
 * live, whatever Nexus held; inactive ends a live portal, a pending one more
 * than a day old, or a draft; draft keeps a pending one pending and a failed
 * one failed (Bayut shows every new listing as a draft, so a draft cannot tell
 * a lost publish from one never received: the 24-hour guard retries it), and
 * turns a live one into a draft. Nexus's own record of a removal or a refusal
 * is never overwritten by inactive or draft. A state read back never clears
 * Bayut's words on a portal that stays live or pending, and a take-down Bayut
 * does not accept writes nothing at all: rule 1 tries it again.
 *
 * At most 40 Bayut calls a minute for each business (`bayut-budget.ts`): when
 * spent, that business stops for this run and the next one goes on. A 429
 * pauses that business for Bayut's retry_after; a 409 leaves the unit for the
 * next run, writing nothing; a refused token (a 401, `bayut.ts`) is recorded on
 * the business's settings, if it is still the token saved, and stops it. A 404
 * on a take-down means the listing is not there: it is recorded taken off. One
 * unit's failure never stops the next, and one business's never stops
 * another's. The token never appears in a log line.
 *
 * A business whose last check could not reach Bayut, with a known account, is
 * checked again at the start of each cycle — one `GET /agencies` — and synced
 * in that cycle if it passes; a refused token never is (final review I6).
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §1, §7, §9, §10, §11
 */

type Options = {
  client: BayutClient;
  budget?: Budget;
  now?: () => Date;
  /** Where Bayut's amenity ids are kept (and the budget's counts, when no budget is given). */
  redis?: BayutRedis;
};

type AmenityIds = Partial<Record<Amenity, string>>;
type Wanted = { listing: PortalListing; portals: BayutPortal[]; userId: number; locationId: number };
type Unit = { unitId: string; held: BayutRemote; stopped: boolean; syncedAt?: Record<BayutPortal, string | null> };
type Run = {
  organizationId: string;
  timezone: string;
  token: string;
  /** The Bayut account the run started on: every write is kept to it. */
  agencyId: number;
  client: BayutClient;
  budget: Budget;
  redis: () => BayutRedis;
  now: Date;
  /** The time now, for a publish asked (`now` is when the run started). */
  clock: () => Date;
  /** Bayut's amenity ids for this run; null until read, "none" when no map could be had. */
  amenityIds: AmenityIds | "none" | null;
  /** `<unitId> <portal>` shown active by this run's state list. */
  active: Set<string>;
  /** True when this run read Bayut's whole state list, every page. */
  statesRead: boolean;
  done: { steps: number; failed: number };
};
/** A message left out keeps Bayut's words on the row; null clears them. */
type Write = { state: BayutState; message?: string | null; fingerprint?: string; publishedAt?: Date; permitComment?: string | null };

const AMENITIES_KEPT_SECONDS = 24 * 60 * 60;
const USERS_FORGOTTEN_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_RETRY_AFTER = 60;
/** 10,000 listings: a bound on the state list even when the budget cannot count (Redis down). */
const MAX_PAGES = 100;
const PERMIT_CHECKS_PER_CYCLE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

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
/** A write landed nowhere: the business is no longer on the run's Bayut account. The run stops, writing nothing more. */
class Stale extends Stop {
  constructor() {
    super("the Bayut account changed during this run");
  }
}

/**
 * Every business with a checked token and a known agency — first checking
 * again, once, those whose last check could not reach Bayut.
 */
export async function runBayutCycle(opts: Options): Promise<{ businesses: number; steps: number; failed: number }> {
  const result = { businesses: 0, steps: 0, failed: 0 };
  for (const { organizationId } of await bayutBusinessesToCheckAgain()) {
    try {
      await checkAgain(organizationId, opts);
    } catch (err) {
      logger.warn({ organizationId, err: why(err) }, "Could not check the Bayut token again — tried again next cycle");
    }
  }
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

/**
 * A token whose last check could not reach Bayut, checked again by the sync:
 * one `GET /agencies`, inside the call budget, recorded as Check again records
 * it (another account turns the switches off). The Bayut users are not read
 * again; another account forgets the old account's, as Check again does.
 */
async function checkAgain(organizationId: string, opts: Options): Promise<void> {
  const held = await bayutToken(organizationId);
  if (!held || held.agencyId === null) return;
  const budget = opts.budget ?? bayutBudget({ redis: opts.redis, now: opts.now });
  if ((await budget.paused(organizationId)) || !(await budget.take(organizationId, 1))) return;
  const answer = await opts.client.agencies(held.token);
  if (!answer.ok && answer.kind === "rate-limited") await budget.pause(organizationId, answer.retryAfter ?? DEFAULT_RETRY_AFTER);
  const check = bayutCheckOf(answer, held.token);
  const { accountChanged } = await recordBayutCheck(organizationId, check);
  if (accountChanged) {
    try {
      await bayutRedis({ redis: opts.redis }).set(bayutUsersKey(organizationId), "[]", "EX", USERS_FORGOTTEN_SECONDS);
    } catch (err) {
      logger.warn({ organizationId, err: why(err) }, "Could not forget the old Bayut account's users in Redis");
    }
  }
  logger.info({ organizationId, passed: check.checkError === null, accountChanged }, "The Bayut sync checked the token again");
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
  const clock = () => opts.now?.() ?? new Date();
  const now = clock();
  const run: Run = {
    organizationId,
    timezone,
    token: held.token,
    agencyId: held.agencyId,
    client: opts.client,
    budget,
    redis: () => bayutRedis({ redis: opts.redis }),
    now,
    clock,
    amenityIds: null,
    active: new Set(),
    statesRead: false,
    done: { steps: 0, failed: 0 },
  };
  try {
    const units: Unit[] = (await bayutUnitsToSync(organizationId))
      .filter((u) => !onlyUnit || u.unitId === onlyUnit)
      .map((u) => ({ unitId: u.unitId, held: structuredClone(u.remote), stopped: false }));
    // Nothing to sync means nothing is wanted: no unit can be wanted and ready.
    let wanted = new Map<string, Wanted>();
    if (units.length > 0) {
      wanted = new Map((await bayutListings(organizationId, todayIn(timezone, now), photoUrl)).map((w) => [w.listing.reference, w]));
      await removals(run, units, wanted);
      await sends(run, units, wanted);
    }
    if (onlyUnit) return run.done;
    // Read again after the sends: every unit Nexus holds a ref for, as now written.
    const onBayut: Unit[] = (await bayutUnitsHeld(organizationId)).map((u) => ({
      unitId: u.unitId,
      held: u.remote,
      stopped: false,
      syncedAt: u.syncedAt,
    }));
    if (onBayut.length === 0) return run.done;
    await states(run, onBayut, wanted);
    await rejections(run, onBayut);
    await permitChecks(run, onBayut);
  } catch (err) {
    if (err instanceof TokenRefused) {
      // Only on the token the run used: one an admin saved meanwhile has its own check.
      if ((await bayutToken(organizationId))?.token === held.token) {
        await recordBayutCheck(organizationId, { checkError: `Bayut refused the token: ${err.message}`, agencyId: null, agencyName: null });
      }
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
 * One Bayut call, counted against the budget; `sending`, if given, runs once
 * the budget allows the call, just before it is sent. A refused token and a 429
 * stop the business (the 429 pauses it first); every other answer is the caller's.
 */
async function ask<T>(
  run: Run,
  call: (client: BayutClient, token: string) => Promise<BayutAnswer<T>>,
  sending?: () => Promise<void>
): Promise<BayutAnswer<T>> {
  if (!(await run.budget.take(run.organizationId, 1))) throw new Stop("the call budget for this minute is spent");
  await sending?.();
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

/** Bayut's answer on one portal's row, with the unit's ref, and kept in step in memory. Stale when it lands nowhere. */
async function record(run: Run, unit: Unit, portal: BayutPortal, w: Write): Promise<void> {
  const written = await recordBayutStep(run.organizationId, run.agencyId, unit.unitId, portal, {
    ...(unit.held.ref ? { ref: unit.held.ref } : {}),
    ...w,
  });
  if (!written) throw new Stale();
  const before = unit.held.portals[portal];
  unit.held.portals[portal] = { state: w.state, publishedAt: w.publishedAt ? w.publishedAt.toISOString() : before.publishedAt };
  if (w.fingerprint) unit.held.fingerprint = w.fingerprint;
}

/** When a publish was asked, on its own (null: none); kept in step in memory. Stale when it lands nowhere. */
async function publishAsked(run: Run, unit: Unit, portal: BayutPortal, at: string | null): Promise<void> {
  if (!(await bayutPublishAsked(run.organizationId, run.agencyId, unit.unitId, portal, at === null ? null : new Date(at)))) {
    throw new Stale();
  }
  unit.held.portals[portal] = { ...unit.held.portals[portal], publishedAt: at };
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
    // No amenity map was ever read: nothing is created or updated this run (each listing would be sent twice).
    if (run.amenityIds === "none") return;
    await each(run, unit, async () => {
      const amenityIds = await amenities(run);
      if (amenityIds === null) return;
      const body = toBayutListing(want.listing, { userId: want.userId, locationId: want.locationId, amenityIds });
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

/** A map kept in Redis under `key`; null when it is not there or Redis cannot give it back. */
async function keptAmenities(run: Run, key: string): Promise<AmenityIds | null> {
  try {
    const kept = await run.redis().get(key);
    return kept ? (JSON.parse(kept) as AmenityIds) : null;
  } catch (err) {
    logger.warn({ organizationId: run.organizationId, err: why(err) }, "Could not read Bayut's amenity ids from Redis");
    return null;
  }
}

/**
 * Bayut's amenity ids: read from Bayut once a day for each business, and the
 * last good map kept with no expiry, for a day Bayut cannot say (final review,
 * 24 Nov 2026). Null when no map was ever read: the caller then sends nothing.
 */
async function amenities(run: Run): Promise<AmenityIds | null> {
  if (run.amenityIds) return run.amenityIds === "none" ? null : run.amenityIds;
  const fresh = `bayut-amenities:${run.organizationId}`;
  const lastGood = `bayut-amenities-last:${run.organizationId}`;
  const kept = await keptAmenities(run, fresh);
  if (kept) return (run.amenityIds = kept);
  const a = await ask(run, (c, t) => c.amenities(t));
  if (!a.ok) {
    const last = await keptAmenities(run, lastGood);
    if (last) return (run.amenityIds = last);
    run.amenityIds = "none";
    logger.info(
      { organizationId: run.organizationId, kind: a.kind, message: a.message },
      "Bayut's amenity ids could not be read and none are kept — no listing is created or updated this run"
    );
    return null;
  }
  const ids = matchAmenities(a.data);
  try {
    await run.redis().set(fresh, JSON.stringify(ids), "EX", AMENITIES_KEPT_SECONDS);
    await run.redis().set(lastGood, JSON.stringify(ids));
  } catch (err) {
    logger.warn({ organizationId: run.organizationId, err: why(err) }, "Could not keep Bayut's amenity ids in Redis");
  }
  return (run.amenityIds = ids);
}

/** True when the unit may go on to its next step. */
async function remove(run: Run, unit: Unit, portals: BayutPortal[]): Promise<boolean> {
  const a = await ask(run, (c, t) => c.remove(t, unit.held.ref!, portals));
  run.done.steps += 1;
  // A 404: the listing is not on Bayut, so it is off — recorded, or it would be asked for ever.
  if (a.ok || a.notFound) {
    for (const p of portals) await record(run, unit, p, { state: "unpublished", message: null });
    return true;
  }
  // Still on Bayut (or busy): nothing is written, so the state stays and the next run tries again (rule 1).
  // No words either: the card already says "Coming off Bayut", and they could be read as a refused change.
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
        // A refusal keeps Bayut's words (the last change was refused); an unanswered update is simply sent again.
        const advertised = state === "live" || state === "pending" || (state === "draft" && publishedAt !== null);
        if (advertised && state) {
          if (refused) await record(run, unit, p, { state, message: a.message, fingerprint });
          continue;
        }
        await record(run, unit, p, { state: refused ? "refused" : "failed", message: a.message, ...(refused ? { fingerprint } : {}) });
      } else if (refused) {
        // Both rows remember what was refused, so it waits for a change.
        await record(run, unit, p, { state: state ?? "unpublished", message: null, fingerprint });
      }
    }
    return false;
  }

  // publish: the time it is asked is written first, so a worker stopped in the middle of the call has counted it.
  const asked = run.clock();
  const before = new Map(step.portals.map((p) => [p, held.portals[p].publishedAt]));
  let counted = false;
  // Bayut did not take the publish: the time held before comes back, so it is asked again (or, refused, not counted).
  const putBack = async () => {
    for (const p of step.portals) await publishAsked(run, unit, p, before.get(p) ?? null);
  };
  let a: BayutAnswer<null>;
  try {
    a = await ask(
      run,
      (c, t) => c.publish(t, held.ref!, step.portals),
      async () => {
        for (const p of step.portals) await publishAsked(run, unit, p, asked.toISOString());
        counted = true;
      }
    );
  } catch (err) {
    // A 429 or a refused token: Bayut did not take it.
    if (counted && (err instanceof TokenRefused || (err instanceof Stop && !(err instanceof Stale)))) await putBack();
    throw err;
  }
  run.done.steps += 1;
  if (a.ok) {
    for (const p of step.portals) await record(run, unit, p, { state: "pending", message: null, publishedAt: asked });
    return true;
  }
  if (a.kind === "busy" || a.kind === "refused") await putBack();
  if (a.kind === "busy") return false;
  for (const p of step.portals) {
    // A publish that may have reached Bayut counts for the 24-hour guard; a refused one does not.
    await record(
      run,
      unit,
      p,
      a.kind === "refused" ? { state: "refused", message: a.message, fingerprint } : { state: "failed", message: a.message, publishedAt: asked }
    );
  }
  return false;
}

/** (3) Bayut's state list, one call per 100 listings, read for every unit Nexus holds a ref for. */
async function states(run: Run, units: Unit[], wanted: Map<string, Wanted>): Promise<void> {
  const seen = new Map<string, { name: string; state: string }[]>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const a = await ask(run, (c, t) => c.list(t, run.agencyId, page));
    if (!a.ok) {
      // What was read is used; the rest waits for the next cycle. Bayut's words have the token blanked (bayut.ts).
      logger.warn(
        { organizationId: run.organizationId, page, status: a.kind, message: a.message },
        "Could not read Bayut's state list — what was read is used, the rest waits for the next cycle"
      );
      break;
    }
    for (const item of a.data.items) seen.set(item.id, item.portals);
    if (!a.data.next) {
      run.statesRead = true;
      break;
    }
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
  // A publish asked in the last day: Bayut's list can still show the state from before it.
  const askedToday = publishedAt !== null && run.now.getTime() - Date.parse(publishedAt) < DAY_MS;
  // A portal that stays live or pending keeps Bayut's words about a refused change.
  const words = state === "live" || state === "pending" ? {} : { message: null };
  if (theirs === "active") {
    run.active.add(at(unit, p));
    await record(run, unit, p, { state: "live", ...words });
    return;
  }
  if (theirs === "inactive") {
    if (state === "live" || (state === "pending" && !askedToday)) {
      if (stillWanted) {
        // Rule 9: Bayut took it down. The switch goes off; staff decide whether to spend the credits again.
        if (!(await bayutTakenOff(run.organizationId, run.agencyId, unit.unitId, p, dayMonthIn(run.timezone, run.now)))) throw new Stale();
        unit.held.portals[p] = { state: "unpublished", publishedAt };
        return;
      }
      await record(run, unit, p, { state: "unpublished", message: null });
      return;
    }
    if (state === "draft" || state === null) await record(run, unit, p, { state: "unpublished", message: null });
    return; // pending less than a day old, unpublished, refused, failed: left as it is
  }
  if (theirs === "draft") {
    // Pending stays pending (rule 7: never published again). Failed stays failed, with its words: Bayut shows
    // every new listing as a draft, so a draft cannot tell a lost publish from one Bayut never received, and
    // the 24-hour guard retries it once the day is up.
    if (state === "live" || state === null) await record(run, unit, p, { state: "draft", ...words });
  }
  // Any other word from Bayut: left as it is.
}

/**
 * A rejection that may be of what Bayut holds now: one dated at or after the
 * portal's last publish, or any rejection of a portal never published. Bayut's
 * first page keeps old ones, and an undated one cannot be told from them.
 */
const rejectedSince = (rejectedAt: string | null, publishedAt: string | null): boolean =>
  publishedAt === null || (rejectedAt !== null && Date.parse(rejectedAt) >= Date.parse(publishedAt));

/** (4) Bayut's rejected list, one call: the listings Nexus made become refused with Bayut's reason. */
async function rejections(run: Run, units: Unit[]): Promise<void> {
  const a = await ask(run, (c, t) => c.rejected(t));
  if (!a.ok) return;
  for (const rejection of a.data) {
    for (const unit of units.filter((u) => u.held.ref === rejection.id)) {
      await each(run, unit, async () => {
        for (const p of BAYUT_PORTALS) {
          const { state, publishedAt } = unit.held.portals[p];
          if (state !== "pending" && state !== "draft" && state !== "live") continue;
          if (run.active.has(at(unit, p))) continue; // Bayut shows it live: that wins
          if (state === "live" && !run.statesRead) continue; // and without Bayut's whole list, it may be showing it live
          if (!rejectedSince(rejection.at, publishedAt)) continue; // an older publish's rejection
          await record(run, unit, p, { state: "refused", message: rejection.reason || null });
        }
      });
    }
  }
}

/** (5) The permit check of pending units, for the card: at most 10 a cycle, the longest waiting first. */
async function permitChecks(run: Run, units: Unit[]): Promise<void> {
  const waiting = units
    .map((unit) => ({ unit, pending: BAYUT_PORTALS.filter((p) => unit.held.portals[p].state === "pending") }))
    .filter((w) => w.pending.length > 0)
    .map((w) => ({ ...w, since: Math.min(...w.pending.map((p) => Date.parse(w.unit.syncedAt?.[p] ?? "") || 0)) }))
    .sort((a, b) => a.since - b.since)
    .slice(0, PERMIT_CHECKS_PER_CYCLE);
  for (const { unit, pending } of waiting) {
    await each(run, unit, async () => {
      const a = await ask(run, (c, t) => c.show(t, unit.held.ref!));
      if (!a.ok || !a.data.permit) return;
      const permitComment = a.data.permit.comment ?? a.data.permit.status;
      for (const p of pending) await record(run, unit, p, { state: "pending", permitComment });
    });
  }
}
