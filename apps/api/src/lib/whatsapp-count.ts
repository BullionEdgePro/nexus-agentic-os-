import { env } from "../config/env.js";
import { getRedisConnection } from "../queue/queue.js";
import { logger } from "./logger.js";

/**
 * What WhatsApp itself counted for a campaign (13 Nov 2026).
 *
 * ============================================================
 * WHY NEXUS ASKS META INSTEAD OF TRUSTING ITS OWN COLUMN
 * ============================================================
 *
 * The first SFS campaign went to 207 customers on 12 Nov. Meta's dashboard said
 * 150 delivered, AED 32.89. Nexus said "Delivered 4": Meta had pushed four
 * delivery receipts for that number and no more, and a count built on receipts
 * can only be as good as the receipts. The owner asked what it cost, twice, and
 * Nexus had no way to say.
 *
 * Meta answers both through its analytics, for a NUMBER over a STRETCH OF TIME —
 * it has no notion of a Nexus campaign. So a campaign is given the stretch that
 * is its own: the day after its first send, in Meta's half-hour steps, cut short
 * by the next campaign from the same number. Inside that stretch the template
 * messages delivered from the number are, near enough, the campaign; a test send
 * or a second template in the same hours is counted with it, which is why the
 * screen calls it WhatsApp's count and keeps Nexus's own beside it.
 *
 * Meta not answering is NOTHING, never zero: the screen shows no line at all.
 */
export interface WhatsAppCount {
  /** Template messages Meta counts as delivered from the number in the stretch. */
  delivered: number;
  /** Approximate charges for the stretch; null when Meta did not say. */
  cost: number | null;
  /** The WhatsApp account's currency, as Meta names it ("AED"). */
  currency: string | null;
}

const HALF_HOUR = 1800;
const DAY = 86_400;

/** The stretch that is one campaign's own, in Unix seconds — or null when it has none. */
export function countingPeriod(firstSentAt: Date, nextCampaignAt: Date | null, now: Date): { start: number; end: number } | null {
  const start = Math.floor(firstSentAt.getTime() / 1000 / HALF_HOUR) * HALF_HOUR;
  const ends = [start + DAY, Math.ceil(now.getTime() / 1000 / HALF_HOUR) * HALF_HOUR];
  // Two campaigns inside one half hour cannot be told apart: the stretch is
  // empty and neither is given a count that is partly the other's.
  if (nextCampaignAt) ends.push(Math.floor(nextCampaignAt.getTime() / 1000 / HALF_HOUR) * HALF_HOUR);
  const end = Math.min(...ends);
  return end > start ? { start, end } : null;
}

interface Point {
  delivered?: unknown;
  volume?: unknown;
  cost?: unknown;
}
const total = (points: Point[], key: keyof Point): number =>
  points.reduce((sum, point) => sum + (typeof point[key] === "number" ? (point[key] as number) : 0), 0);

/**
 * Meta's two answers, read into one count.
 *
 * Either may be missing (refused, unsupported on this Graph version, timed
 * out). The message count is the better "delivered" — it is template messages
 * only; when it is missing, the messages Meta PRICED in the stretch stand in.
 */
export function countFrom(messaging: unknown, pricing: unknown): WhatsAppCount | null {
  const analytics = (messaging as { analytics?: { data_points?: Point[] } } | null)?.analytics;
  const priced = (pricing as { pricing_analytics?: { data?: Array<{ data_points?: Point[] }> } } | null)?.pricing_analytics;
  if (!analytics && !priced) return null;
  const pricedPoints = (priced?.data ?? []).flatMap((part) => part.data_points ?? []);
  const currency = (pricing as { currency?: unknown } | null)?.currency;
  return {
    delivered: analytics ? total(analytics.data_points ?? [], "delivered") : total(pricedPoints, "volume"),
    cost: priced ? Math.round(total(pricedPoints, "cost") * 100) / 100 : null,
    currency: priced && typeof currency === "string" ? currency : null,
  };
}

async function ask(path: string, fields: string, token: string): Promise<unknown | null> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${env.metaGraphApiVersion}/${path}?fields=${encodeURIComponent(fields)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const json = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!response.ok) {
      logger.warn({ path, status: response.status, reason: json?.error?.message ?? null }, "WhatsApp did not give its count");
      return null;
    }
    return json;
  } catch (err) {
    logger.warn({ path, err }, "WhatsApp could not be asked for its count");
    return null;
  }
}

/** What Meta counted for one number over one stretch; null when it would not say. */
export async function readWhatsAppCount(input: {
  phoneNumberId: string;
  wabaId: string;
  start: number;
  end: number;
  token: string;
}): Promise<WhatsAppCount | null> {
  // Meta's analytics name a number by its digits, not by its id.
  const number = (await ask(input.phoneNumberId, "display_phone_number", input.token)) as { display_phone_number?: unknown } | null;
  const digits = typeof number?.display_phone_number === "string" ? number.display_phone_number.replace(/\D/g, "") : "";
  if (!digits) return null;

  const stretch = `.start(${input.start}).end(${input.end}).granularity(HALF_HOUR).phone_numbers(["${digits}"])`;
  const [messaging, pricing] = await Promise.all([
    // product_types 0: template messages — what a campaign sends.
    ask(input.wabaId, `analytics${stretch}.product_types([0])`, input.token),
    ask(input.wabaId, `currency,pricing_analytics${stretch}.dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`, input.token),
  ]);
  return countFrom(messaging, pricing);
}

export interface CountCache {
  get(campaignId: string): Promise<WhatsAppCount | null>;
  set(campaignId: string, value: WhatsAppCount, seconds: number): Promise<void>;
}

const KEY = (campaignId: string) => `wa-campaign-count:${campaignId}`;
/** Kept in Redis; a store that cannot be read or written is simply no cache. */
const kept: CountCache = {
  async get(campaignId) {
    try {
      const raw = await getRedisConnection().get(KEY(campaignId));
      return raw ? (JSON.parse(raw) as WhatsAppCount) : null;
    } catch {
      return null;
    }
  },
  async set(campaignId, value, seconds) {
    try {
      await getRedisConnection().set(KEY(campaignId), JSON.stringify(value), "EX", seconds);
    } catch {
      // No cache this time; the next page load asks Meta again.
    }
  },
};

/** How many campaigns one page load may ask Meta about. */
const ASKED_ABOUT = 5;
/** After its stretch has been over this long, Meta's figures no longer move. */
const SETTLED_AFTER = 6 * 3600;

/**
 * WhatsApp's count for a business's newest campaigns, by campaign id.
 *
 * `campaigns` is newest first (campaignSendTimes). A campaign whose number is no
 * longer connected here, or that Meta will not answer for, is left out.
 */
export async function whatsAppCountsFor(
  campaigns: Array<{ id: string; fromPhoneNumberId: string | null; firstSentAt: string }>,
  deps: {
    /** The WhatsApp account and key for a number, or null when it is not connected here. */
    account: (phoneNumberId: string) => Promise<{ wabaId: string; token: string } | null>;
    read?: typeof readWhatsAppCount;
    cache?: CountCache;
    now?: Date;
  }
): Promise<Record<string, WhatsAppCount>> {
  const read = deps.read ?? readWhatsAppCount;
  const cache = deps.cache ?? kept;
  const now = deps.now ?? new Date();
  const counts: Record<string, WhatsAppCount> = {};

  await Promise.all(
    campaigns.slice(0, ASKED_ABOUT).map(async (campaign) => {
      if (!campaign.fromPhoneNumberId) return;
      const sentAt = new Date(campaign.firstSentAt);
      const next = campaigns
        .filter((other) => other.fromPhoneNumberId === campaign.fromPhoneNumberId && new Date(other.firstSentAt) > sentAt)
        .map((other) => new Date(other.firstSentAt))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const period = countingPeriod(sentAt, next ?? null, now);
      if (!period) return;

      const remembered = await cache.get(campaign.id);
      if (remembered) {
        counts[campaign.id] = remembered;
        return;
      }
      const account = await deps.account(campaign.fromPhoneNumberId);
      if (!account) return;
      const count = await read({ phoneNumberId: campaign.fromPhoneNumberId, ...account, ...period });
      if (!count) return;
      counts[campaign.id] = count;
      const settled = now.getTime() / 1000 > period.end + SETTLED_AFTER;
      await cache.set(campaign.id, count, settled ? 7 * DAY : 600);
    })
  );
  return counts;
}
