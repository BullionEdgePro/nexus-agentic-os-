/**
 * What a business IS, as against what its agent says.
 *
 * ============================================================
 * SET ONCE AT ONBOARDING, NEVER AGAIN
 * ============================================================
 *
 * `update organizations` appeared nowhere in this codebase. Name, timezone,
 * website, the number shown to customers, and the routing keywords were written
 * by `onboardBusiness` and could only be changed by connecting to Postgres.
 *
 * The routing keywords are the reason this matters rather than merely being
 * untidy. On a shared number they decide WHICH BUSINESS a customer reaches, and
 * two of the firms answering this one are competing law practices. A keyword in
 * the wrong list sends somebody's client to the other firm, and correcting it
 * required SQL.
 *
 * ============================================================
 * THE TWO REFUSALS
 * ============================================================
 *
 * Emptying the keywords of an active shared-number business REMOVES IT FROM THE
 * MENU. `findSharedNumberBusinesses` excludes anyone with none — deliberately,
 * because a business the classifier can never reach should not be offered — so
 * the effect of saving an empty list is that the business silently stops
 * receiving customers. That is refused rather than done.
 *
 * And a timezone the runtime does not recognise makes every rota, booking
 * window and forecast fall back to UTC without complaint. `resolvePresence`
 * carries a `fellBackToUtc` flag for exactly that case; this stops it being
 * reachable from a screen.
 */
import { getPool } from "./client.js";

export interface OrganizationSettings {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  websiteUrl: string | null;
  whatsappDisplayNumber: string | null;
  routingKeywords: string[];
  isActive: boolean;
  acceptsSharedNumber: boolean;
  isNumberOwner: boolean;
}

interface Row {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  website_url: string | null;
  whatsapp_display_number: string | null;
  routing_keywords: string[] | null;
  is_active: boolean;
  accepts_shared_number: boolean;
  is_number_owner: boolean;
}

const toSettings = (row: Row): OrganizationSettings => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  timezone: row.timezone,
  websiteUrl: row.website_url,
  whatsappDisplayNumber: row.whatsapp_display_number,
  routingKeywords: row.routing_keywords ?? [],
  isActive: row.is_active,
  acceptsSharedNumber: row.accepts_shared_number,
  isNumberOwner: row.is_number_owner,
});

const SELECT = `select id, slug, name, timezone, website_url, whatsapp_display_number,
                       routing_keywords, is_active, accepts_shared_number, is_number_owner
                  from organizations`;

export async function getOrganizationSettings(
  organizationId: string
): Promise<OrganizationSettings | null> {
  const { rows } = await getPool().query<Row>(`${SELECT} where id = $1`, [organizationId]);
  return rows[0] ? toSettings(rows[0]) : null;
}

/**
 * Keywords this business shares with another answering the same number.
 *
 * ============================================================
 * WHY THIS IS WORTH SHOWING
 * ============================================================
 *
 * A word claimed by two businesses is a word the classifier has to break a tie
 * on, and nobody could see that anywhere. On a number carrying two competing
 * law firms, "attestation" in both lists is not a tidiness problem — it decides
 * which practice gets the client, silently, on a rule neither firm chose.
 *
 * Reported rather than prevented. Two businesses genuinely can both do
 * attestation, and refusing the overlap would be this platform overruling a
 * fact about the world. Showing it lets whoever owns both lists decide.
 */
export async function keywordCollisions(
  organizationId: string
): Promise<Array<{ keyword: string; withSlug: string; withName: string }>> {
  const { rows } = await getPool().query<{
    keyword: string;
    with_slug: string;
    with_name: string;
  }>(
    `with me as (
       select id, whatsapp_phone_number_id, routing_keywords
         from organizations where id = $1
     )
     select lower(k) as keyword, o.slug as with_slug, o.name as with_name
       from me
       cross join lateral unnest(me.routing_keywords) as k
       join organizations o
         on o.whatsapp_phone_number_id = me.whatsapp_phone_number_id
        and o.id <> me.id
        and o.is_active
        and o.accepts_shared_number
        and exists (
          select 1 from unnest(o.routing_keywords) as ok
           where lower(ok) = lower(k)
        )
      order by 1, 2`,
    [organizationId]
  );
  return rows.map((row) => ({
    keyword: row.keyword,
    withSlug: row.with_slug,
    withName: row.with_name,
  }));
}

export interface SettingsRefusal {
  reason: string;
}

/** Does the runtime know this zone? Asked of Intl rather than of a list. */
export function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Tidy a keyword list without deciding anything for the person.
 *
 * Lowercased, trimmed, de-duplicated, blanks dropped. Order is preserved
 * because it is the order somebody typed and there is no reason to disturb it.
 */
export function cleanKeywords(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const word = String(raw ?? "").trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

export async function updateOrganizationSettings(input: {
  organizationId: string;
  name?: string;
  timezone?: string;
  websiteUrl?: string | null;
  whatsappDisplayNumber?: string | null;
  routingKeywords?: string[];
}): Promise<{ settings: OrganizationSettings } | SettingsRefusal> {
  const current = await getOrganizationSettings(input.organizationId);
  if (!current) return { reason: "That business does not exist." };

  const name = input.name?.trim() ?? current.name;
  if (name.length < 2) return { reason: "A business needs a name customers would recognise." };

  const timezone = input.timezone?.trim() || current.timezone;
  if (!isKnownTimezone(timezone)) {
    return {
      reason: `"${timezone}" is not a timezone this system knows. Every rota, booking window and forecast would quietly fall back to UTC. Use a name like Asia/Dubai.`,
    };
  }

  const website =
    input.websiteUrl === undefined ? current.websiteUrl : input.websiteUrl?.trim() || null;
  if (website && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(website)) {
    return { reason: "A website address should start with http:// or https:// and name a domain." };
  }

  const keywords =
    input.routingKeywords === undefined
      ? current.routingKeywords
      : cleanKeywords(input.routingKeywords);

  // THE REFUSAL THAT MATTERS. findSharedNumberBusinesses excludes a business
  // with no keywords, so saving an empty list takes it off the menu and it
  // stops receiving customers -- with nothing anywhere reporting it, because
  // from the platform's side nothing failed.
  if (keywords.length === 0 && current.isActive && current.acceptsSharedNumber) {
    return {
      reason:
        "This business answers on a shared number, and with no keywords the routing menu stops offering it — customers could no longer reach it at all. Add at least one word customers use.",
    };
  }

  const { rows } = await getPool().query<Row>(
    `update organizations
        set name = $2,
            timezone = $3,
            website_url = $4,
            whatsapp_display_number = $5,
            routing_keywords = $6,
            updated_at = now()
      where id = $1
      returning id, slug, name, timezone, website_url, whatsapp_display_number,
                routing_keywords, is_active, accepts_shared_number, is_number_owner`,
    [
      input.organizationId,
      name,
      timezone,
      website,
      input.whatsappDisplayNumber === undefined
        ? current.whatsappDisplayNumber
        : input.whatsappDisplayNumber?.trim() || null,
      keywords,
    ]
  );
  if (!rows[0]) return { reason: "That business could not be updated." };
  return { settings: toSettings(rows[0]) };
}
