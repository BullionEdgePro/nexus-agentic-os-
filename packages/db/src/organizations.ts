import { getPool } from "./client.js";
import type { Organization } from "@nexus/shared";

interface OrganizationRow {
  id: string;
  slug: Organization["slug"];
  name: string;
  whatsapp_phone_number_id: string;
  whatsapp_business_account_id: string;
  timezone: string;
  created_at: string;
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    whatsappBusinessAccountId: row.whatsapp_business_account_id,
    timezone: row.timezone,
    createdAt: row.created_at,
  };
}

/**
 * The organization that OWNS this number — the tenant contacts, conversations
 * and messages are stored under.
 *
 * Once a number is shared this query matches several rows, so the ordering is
 * load-bearing rather than cosmetic: without it Postgres may return the rows in
 * any order and the "owner" of a conversation could differ between two calls in
 * the same request. Nothing would error; the data would just drift.
 *
 * `is_number_owner` makes the answer an explicit fact (migration 009); the
 * created_at/id tiebreak only ever applies if nobody has been marked, and is
 * there so the result is still deterministic in that case.
 */
export async function findOrganizationByPhoneNumberId(
  phoneNumberId: string
): Promise<Organization | null> {
  const { rows } = await getPool().query<OrganizationRow>(
    `select id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id,
            timezone, created_at
     from organizations
     where whatsapp_phone_number_id = $1 and is_active = true
     order by is_number_owner desc, created_at asc, id asc
     limit 1`,
    [phoneNumberId]
  );
  return rows[0] ? toOrganization(rows[0]) : null;
}

export async function findOrganizationById(id: string): Promise<Organization | null> {
  const { rows } = await getPool().query<OrganizationRow>(
    `select id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id,
            timezone, created_at
     from organizations
     where id = $1 and is_active = true`,
    [id]
  );
  return rows[0] ? toOrganization(rows[0]) : null;
}

export async function findOrganizationBySlug(slug: string): Promise<Organization | null> {
  const { rows } = await getPool().query<OrganizationRow>(
    `select id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id,
            timezone, created_at
     from organizations
     where slug = $1 and is_active = true`,
    [slug]
  );
  return rows[0] ? toOrganization(rows[0]) : null;
}

export async function listOrganizations(): Promise<Organization[]> {
  const { rows } = await getPool().query<OrganizationRow>(
    `select id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id,
            timezone, created_at
     from organizations
     where is_active = true
     order by name asc`
  );
  return rows.map(toOrganization);
}

/**
 * The dialable number for each business, for building customer-facing links.
 *
 * Deliberately its own query rather than a column on the shared organization
 * read. It was on that read for about an hour, which put it in
 * `findOrganizationByPhoneNumberId` — the FIRST call the inbound webhook makes.
 * A column referenced before its migration runs makes that query throw, and the
 * blast radius of a marketing feature became "no customer gets a reply".
 *
 * Isolated here, the worst case is that deep links are unavailable until the
 * migration catches up, which nobody's customer ever notices. The rule this
 * encodes: the reply path must not depend on a column added for anything else.
 *
 * Returns an empty map rather than throwing when the column does not exist yet,
 * so a deploy in either order degrades to "no links" instead of an error.
 */
export async function getDisplayNumbers(): Promise<Map<string, string>> {
  try {
    const { rows } = await getPool().query<{ id: string; whatsapp_display_number: string | null }>(
      `select id, whatsapp_display_number from organizations where is_active = true`
    );
    return new Map(
      rows
        .filter((row): row is { id: string; whatsapp_display_number: string } =>
          Boolean(row.whatsapp_display_number)
        )
        .map((row) => [row.id, row.whatsapp_display_number])
    );
  } catch {
    // Migration 022 has not run yet. Not an error worth propagating: the caller
    // is building links, and no links is a correct answer when no number is
    // recorded.
    return new Map();
  }
}
