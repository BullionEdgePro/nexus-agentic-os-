import { createHash } from "node:crypto";
import { pfNextStep, type PfRemote, type PortalListing } from "@nexus/shared";
import { pfBusinesses, pfCredentials, pfUnitsToSync, publishedListings, recordPfCheck, recordPfStep } from "@nexus/db";
import type { PfAnswer, PfClient, PfCredentials } from "../lib/property-finder.js";
import { apiBaseUrl } from "../lib/public-urls.js";
import { logger } from "../lib/logger.js";

/**
 * The Property Finder sync (7 Nov 2026): for every business with a working key,
 * each unit wanted on Property Finder or still live there gets one step, and
 * Property Finder's answer is written on the unit.
 *
 * - Should be live = wanted AND ready, decided now by the feed's own query
 *   (`publishedListings`), never stored.
 * - A create or update that succeeds is published in the same run.
 * - A refusal stores the fingerprint of what was refused, so the same listing
 *   is not sent again until it changes; a failure keeps the old one, so it is
 *   tried again next cycle.
 * - An unpublish that does not succeed leaves the unit "live" with Property
 *   Finder's words, so it is tried again rather than forgotten.
 * - A refused key stops that business (recorded on its settings) and no other.
 * - One unit's failure never stops the next.
 * - Nothing runs while the listing calls are not built (`ready` false).
 *
 * Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §5
 */

/**
 * Every unit is looked at each cycle; at most 50 steps are SENT (final review).
 * A unit in step costs nothing to look at, and a cap on units looked at would
 * show the same oldest fifty every cycle — an expired permit past the fiftieth
 * would never come off.
 */
const STEPS_PER_CYCLE = 50;
const UNITS_LOOKED_AT = 10_000;

type Options = { client: PfClient; ready: boolean };

/** A stable fingerprint of the listing as it would be sent: keys sorted, `updatedAt` left out. */
export function pfFingerprint(listing: PortalListing): string {
  const { updatedAt: _updatedAt, ...rest } = listing;
  return createHash("sha256").update(canonical(rest)).digest("hex");
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

const todayIn = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
const photoUrl = (photoId: string) => `${apiBaseUrl()}/portal-photos/${photoId}.jpg`;

class KeyRefused extends Error {}

/** What should be live now, by unit id. */
async function shouldBeLive(organizationId: string, timezone: string): Promise<Map<string, PortalListing>> {
  const listings = await publishedListings(organizationId, ["property_finder"], todayIn(timezone), photoUrl);
  return new Map(listings.map((l) => [l.reference, l]));
}

/** One unit, one step. Returns whether anything was sent. Throws KeyRefused to stop the business. */
async function syncOne(
  organizationId: string,
  creds: PfCredentials,
  client: PfClient,
  unitId: string,
  remote: PfRemote,
  live: Map<string, PortalListing>
): Promise<boolean> {
  const listing = live.get(unitId) ?? null;
  const fingerprint = listing ? pfFingerprint(listing) : null;
  const step = pfNextStep({ live: !!listing, fingerprint }, remote);
  if (step === "none") return false;

  const fail = async (a: Exclude<PfAnswer, { ok: true }>, extra: { ref?: string; fingerprint?: string } = {}) => {
    if (a.kind === "key-refused") throw new KeyRefused(a.message);
    await recordPfStep(organizationId, unitId, {
      ...extra,
      state: a.kind === "refused" ? "refused" : "failed",
      message: a.message,
      // A refusal remembers what was refused, so it waits for a change.
      ...(a.kind === "refused" && fingerprint ? { fingerprint } : {}),
    });
  };

  const publish = async (ref: string, sent: string | undefined) => {
    const p = await client.publishListing(creds, ref);
    if (p.ok) await recordPfStep(organizationId, unitId, { ref, state: "live", message: null, fingerprint: sent });
    else await fail(p, { ref, fingerprint: sent });
  };

  if (step === "unpublish") {
    const u = await client.unpublishListing(creds, remote.ref!);
    if (u.ok) await recordPfStep(organizationId, unitId, { state: "unpublished", message: null });
    else if (u.kind === "key-refused") throw new KeyRefused(u.message);
    // Still live on Property Finder: keep it "live" so the next run tries again.
    else await recordPfStep(organizationId, unitId, { state: "live", message: u.message });
    return true;
  }
  if (step === "publish") {
    await publish(remote.ref!, undefined);
    return true;
  }
  if (step === "create") {
    const c = await client.createListing(creds, listing!);
    if (!c.ok) return fail(c).then(() => true);
    if (!c.ref) return fail({ ok: false, kind: "unreachable", message: "Property Finder answered without a listing reference" }).then(() => true);
    // The reference is written the moment Property Finder gives it, before
    // publishing: whatever happens next, the listing is never created twice.
    await recordPfStep(organizationId, unitId, { ref: c.ref, state: "unpublished", message: null, fingerprint: fingerprint! });
    await publish(c.ref, fingerprint!);
    return true;
  }
  // update
  const u = await client.updateListing(creds, remote.ref!, listing!);
  if (!u.ok) return fail(u).then(() => true);
  await publish(remote.ref!, fingerprint!);
  return true;
}

/** Every business with a working key; up to 50 units each, never-sent first. */
export async function runPfCycle(opts: Options): Promise<{ businesses: number; steps: number; failed: number }> {
  const result = { businesses: 0, steps: 0, failed: 0 };
  if (!opts.ready) return result;
  for (const business of await pfBusinesses()) {
    result.businesses += 1;
    // One business's error never stops the others (final review).
    try {
      const done = await syncBusiness(business.organizationId, business.timezone, opts, null);
      result.steps += done.steps;
      result.failed += done.failed;
    } catch (err) {
      result.failed += 1;
      logger.warn(
        { organizationId: business.organizationId, err: err instanceof Error ? err.message : String(err) },
        "Property Finder sync failed for this business — the others go on, and it is tried again next cycle"
      );
    }
  }
  return result;
}

/** One unit, soon after it changed. Does nothing when the business has no working key. */
export async function runPfUnit(organizationId: string, unitId: string, opts: Options): Promise<void> {
  if (!opts.ready) return;
  const business = (await pfBusinesses()).find((b) => b.organizationId === organizationId);
  if (!business) return;
  await syncBusiness(organizationId, business.timezone, opts, unitId);
}

async function syncBusiness(
  organizationId: string,
  timezone: string,
  opts: Options,
  onlyUnit: string | null
): Promise<{ steps: number; failed: number }> {
  const done = { steps: 0, failed: 0 };
  const creds = await pfCredentials(organizationId);
  if (!creds) return done;
  const units = (await pfUnitsToSync(organizationId, UNITS_LOOKED_AT)).filter((u) => !onlyUnit || u.unitId === onlyUnit);
  if (units.length === 0) return done;
  const live = await shouldBeLive(organizationId, timezone);
  for (const unit of units) {
    if (done.steps >= STEPS_PER_CYCLE) break;
    try {
      if (await syncOne(organizationId, creds, opts.client, unit.unitId, unit.remote, live)) done.steps += 1;
    } catch (err) {
      if (err instanceof KeyRefused) {
        await recordPfCheck(organizationId, `Property Finder refused the key: ${err.message}`);
        logger.warn({ organizationId }, "Property Finder refused the key — this business's sync stops until an admin checks it");
        break;
      }
      done.failed += 1;
      logger.warn(
        { organizationId, unitId: unit.unitId, err: err instanceof Error ? err.message : String(err) },
        "A Property Finder step failed — the unit is tried again next cycle"
      );
    }
  }
  return done;
}
