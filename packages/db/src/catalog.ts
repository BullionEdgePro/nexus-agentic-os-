import { getPool } from "./client.js";

/**
 * The marketplace (F13) — reading the catalogue, and recording what a business
 * has taken from it.
 *
 * READ MIGRATION 039 BEFORE CHANGING ANYTHING HERE. The egress policy is the
 * whole design: nothing leaves. A business installs a template, a procedure or
 * a knowledge pack; it never contributes one. That guarantee is kept by the
 * SHAPE of `catalog_items` — no organization_id, no foreign key to any tenant
 * table — so there is nowhere for one business's material to be recorded and no
 * function in this file could write it there even if someone asked for one.
 *
 * Which is why there is no `createCatalogItem` below, and must never be one:
 * 039 revoked insert on `catalog_items` from `nexus_app`, so authoring is an
 * owner action performed in a migration. A function here would fail at runtime
 * with a permission error, which is the correct outcome but a poor way to
 * discover the rule.
 *
 * TENANT CONTEXT. `catalog_installs` IS in TENANT_SCOPED_TABLES, so every
 * function touching it needs a context or it throws under
 * DB_TENANT_ASSERT=strict. The caller is the operator-only /api/catalog route,
 * which runs cross-tenant (`withAllTenants`) because the operator console spans
 * all five businesses — so the organization_id in each query below is doing the
 * narrowing that RLS would do on a per-business path. That is the same shape as
 * /api/tasks and /api/operators, and it is worth being explicit about: under an
 * "all" context these WHERE clauses are the only thing scoping the rows.
 * Removing one does not fail a test, it silently widens a query.
 *
 * `catalog_items` is deliberately NOT tenant-scoped. It is a shared registry
 * every business reads, like `organizations`.
 */

export type CatalogItemKind = "template" | "procedure" | "knowledge_pack";

export interface CatalogItem {
  id: string;
  slug: string;
  kind: CatalogItemKind;
  title: string;
  summary: string;
  /** Shape depends on `kind`. Authored content only — never a business's own. */
  payload: Record<string, unknown>;
  /** Null means "any business", the honest default for something generic. */
  suitsIndustry: string | null;
  language: string;
  version: number;
  publishedAt: string | null;
  updatedAt: string;
}

export interface CatalogInstall {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  catalogItemId: string;
  itemSlug: string;
  itemTitle: string;
  itemKind: CatalogItemKind;
  /** What this business is actually running. May trail the catalogue. */
  installedVersion: number;
  /** The catalogue's current version, for comparison. */
  availableVersion: number;
  isActive: boolean;
  installedAt: string;
  removedAt: string | null;
}

interface CatalogItemRow {
  id: string;
  slug: string;
  kind: CatalogItemKind;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  suits_industry: string | null;
  language: string;
  version: number;
  published_at: string | null;
  updated_at: string;
}

interface CatalogInstallRow {
  id: string;
  organization_id: string;
  business_name: string;
  business_slug: string;
  catalog_item_id: string;
  item_slug: string;
  item_title: string;
  item_kind: CatalogItemKind;
  installed_version: number;
  available_version: number;
  is_active: boolean;
  installed_at: string;
  removed_at: string | null;
}

const toItem = (row: CatalogItemRow): CatalogItem => ({
  id: row.id,
  slug: row.slug,
  kind: row.kind,
  title: row.title,
  summary: row.summary,
  payload: row.payload,
  suitsIndustry: row.suits_industry,
  language: row.language,
  version: row.version,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
});

const toInstall = (row: CatalogInstallRow): CatalogInstall => ({
  id: row.id,
  organizationId: row.organization_id,
  businessName: row.business_name,
  businessSlug: row.business_slug,
  catalogItemId: row.catalog_item_id,
  itemSlug: row.item_slug,
  itemTitle: row.item_title,
  itemKind: row.item_kind,
  installedVersion: row.installed_version,
  availableVersion: row.available_version,
  isActive: row.is_active,
  installedAt: row.installed_at,
  removedAt: row.removed_at,
});

/**
 * The catalogue, as a business would see it.
 *
 * PUBLISHED ONLY, and that is a rule about what may be installed rather than a
 * display preference — see `installCatalogItem`, which checks it again at the
 * point of writing. An unpublished item is a draft somebody is still working
 * on, and a draft that reached a live agent would be the catalogue changing what
 * customers are told before anyone decided it was ready.
 */
export async function listCatalogItems(): Promise<CatalogItem[]> {
  const { rows } = await getPool().query<CatalogItemRow>(
    `select id, slug, kind, title, summary, payload, suits_industry, language,
            version, published_at, updated_at
       from catalog_items
      where published_at is not null
      -- Kind first so the three groups stay together on the page, then title,
      -- so the order is stable between requests. An unordered list that
      -- reshuffles on every refresh reads as a list that is changing.
      order by kind asc, title asc`
  );
  return rows.map(toItem);
}

export async function findCatalogItemBySlug(slug: string): Promise<CatalogItem | null> {
  const { rows } = await getPool().query<CatalogItemRow>(
    `select id, slug, kind, title, summary, payload, suits_industry, language,
            version, published_at, updated_at
       from catalog_items
      where slug = $1`,
    [slug]
  );
  return rows[0] ? toItem(rows[0]) : null;
}

const INSTALL_SELECT = `
  select ci.id, ci.organization_id,
         o.name as business_name, o.slug as business_slug,
         ci.catalog_item_id,
         it.slug as item_slug, it.title as item_title, it.kind as item_kind,
         ci.installed_version, it.version as available_version,
         ci.is_active, ci.installed_at, ci.removed_at
    from catalog_installs ci
    join organizations o  on o.id = ci.organization_id
    join catalog_items it on it.id = ci.catalog_item_id
`;

/**
 * What every business is currently running, across the platform.
 *
 * Live installs only — `removed_at is null`. A removed row is kept, because it
 * is the record that a business ran that pack for a while, but it is not what
 * the business has now and showing it as such would misreport the platform.
 *
 * CROSS-TENANT BY INTENT, and the operator console is the only caller. Under
 * `withAllTenants` there is no RLS narrowing here at all, so if this is ever
 * called from a per-business path it must be given an organizationId.
 */
export async function listCatalogInstalls(organizationId?: string): Promise<CatalogInstall[]> {
  const { rows } = await getPool().query<CatalogInstallRow>(
    `${INSTALL_SELECT}
      where ci.removed_at is null
        and ($1::uuid is null or ci.organization_id = $1)
      order by o.name asc, it.title asc`,
    [organizationId ?? null]
  );
  return rows.map(toInstall);
}

async function getInstall(id: string): Promise<CatalogInstall | null> {
  const { rows } = await getPool().query<CatalogInstallRow>(`${INSTALL_SELECT} where ci.id = $1`, [
    id,
  ]);
  return rows[0] ? toInstall(rows[0]) : null;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

export type InstallRefusal =
  | "not-published"
  | "already-installed";

export type InstallResult =
  | { ok: true; install: CatalogInstall }
  | { ok: false; refusal: InstallRefusal; message: string };

/**
 * Take a pack into one business.
 *
 * THREE THINGS THIS DOES THAT ARE THE FEATURE RATHER THAN PLUMBING:
 *
 *   1. It copies the version rather than referencing it. If the catalogue moves
 *      to v3, this row still says the business is running v2 — otherwise "what
 *      is this agent doing" has no answer after an update, and a catalogue that
 *      edits itself inside somebody's live agent changes what customers are
 *      told without anyone deciding to.
 *
 *   2. It does not activate. `is_active` stays false, exactly as F10 requires
 *      for a procedure it inferred: material that would enter the prompt for
 *      every future customer wants a human decision, whether the platform wrote
 *      it or the catalogue did.
 *
 *   3. It refuses an unpublished item HERE, not only in the listing. The list
 *      filters drafts out for display; this is the check that means a slug typed
 *      into a request cannot install one.
 *
 * A refusal is returned rather than thrown, because both refusals are ordinary
 * answers to a button press — "you already have this" is not an error condition,
 * it is the state of the world, and a 500 would be the wrong way to say it.
 */
export async function installCatalogItem(
  organizationId: string,
  itemSlug: string
): Promise<InstallResult> {
  const item = await findCatalogItemBySlug(itemSlug);
  if (!item || !item.publishedAt) {
    return {
      ok: false,
      refusal: "not-published",
      message: "That item is not published, so it cannot be installed.",
    };
  }

  try {
    const { rows } = await getPool().query<{ id: string }>(
      `insert into catalog_installs (organization_id, catalog_item_id, installed_version)
       values ($1, $2, $3)
       returning id`,
      [organizationId, item.id, item.version]
    );
    const install = await getInstall(rows[0].id);
    if (!install) {
      // The write succeeded and the read came back empty, which on this
      // platform means a tenant context problem rather than a missing row.
      throw new Error("The install was recorded but could not be read back.");
    }
    return { ok: true, install };
  } catch (err) {
    // Migration 040's partial unique index — one live install per (business,
    // item). Caught rather than surfaced, because two people pressing Install
    // at once is a race the database settles correctly and the loser should see
    // a sentence, not a stack trace.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      return {
        ok: false,
        refusal: "already-installed",
        message: "That business already has this one installed.",
      };
    }
    throw err;
  }
}

/**
 * Take a pack back out.
 *
 * Stamped, not deleted — 039 grants the application no delete on this table, and
 * that is deliberate: a business that ran a pack for six weeks ran it, and the
 * row is the only record of that. Reinstalling later is allowed and produces a
 * new row, which is why migration 040's uniqueness is conditional on
 * `removed_at is null`.
 *
 * Scoped by organization_id as well as by id. Under the cross-tenant context
 * this route runs in, an id alone would remove any business's install.
 */
export async function removeCatalogInstall(
  organizationId: string,
  installId: string
): Promise<CatalogInstall | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `update catalog_installs
        set removed_at = now(),
            -- Removing something that was switched on switches it off. Leaving
            -- is_active true on a removed row would make the honest question
            -- "what is active for this business" answerable two different ways.
            is_active = false
      where id = $1
        and organization_id = $2
        and removed_at is null
      returning id`,
    [installId, organizationId]
  );
  if (!rows[0]) return null;
  return getInstall(rows[0].id);
}

/**
 * Write the `procedures` row a catalogue procedure becomes.
 *
 * MATERIALISES, DOES NOT SWITCH ON. `is_active` is left at its default of
 * false, so nothing here changes a single reply. A person turns it on from
 * "How we answer", which already shows what else is active for that situation
 * and already refuses two at once — see migration 043 for why the decision
 * belongs there rather than behind a button on the catalogue.
 *
 * `source = 'catalog'` because the two existing values are both untrue of it:
 * nobody at this business wrote it, and it was drawn from none of this
 * business's conversations. 043 has the argument, including why the nightly
 * writer deliberately does NOT defer to it.
 *
 * Idempotent by the unique index on `catalog_install_id` (043) rather than by a
 * read-then-write here, which two clicks could interleave. `on conflict do
 * nothing` plus a read-back means the second caller gets the first caller's row
 * rather than an error, which is the honest answer to "activate this" when it
 * is already activated.
 */
export async function materialiseProcedure(input: {
  organizationId: string;
  installId: string;
  intentCategory: string;
  language: string;
  steps: { text: string }[];
}): Promise<{ procedureId: string; created: boolean }> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into procedures
       (organization_id, intent_category, language, steps, source,
        is_active, catalog_install_id)
     values ($1, $2, $3, $4::jsonb, 'catalog', false, $5)
     on conflict (catalog_install_id) where catalog_install_id is not null
       do nothing
     returning id`,
    [
      input.organizationId,
      input.intentCategory,
      input.language,
      JSON.stringify(input.steps),
      input.installId,
    ]
  );

  if (rows[0]) return { procedureId: rows[0].id, created: true };

  // Conflict: the row is already there. Read it back rather than reporting a
  // failure — "already done" and "could not do it" must not look alike.
  const { rows: existing } = await getPool().query<{ id: string }>(
    `select id from procedures where catalog_install_id = $1`,
    [input.installId]
  );
  if (!existing[0]) {
    throw new Error("The procedure was neither written nor found — refusing to report success.");
  }
  return { procedureId: existing[0].id, created: false };
}

/**
 * Record that an install's material is now present in the business.
 *
 * This is what `catalog_installs.is_active` means, and it is worth being exact
 * because the word is overloaded across two tables: TRUE here says "this pack's
 * material has been added to this business", NOT "this pack is shaping replies".
 * Whether the procedure it produced is live is `procedures.is_active`, decided
 * by a person on a different screen.
 */
export async function markInstallActivated(
  organizationId: string,
  installId: string
): Promise<CatalogInstall | null> {
  const { rows } = await getPool().query<{ id: string }>(
    `update catalog_installs
        set is_active = true
      where id = $1
        and organization_id = $2
        and removed_at is null
      returning id`,
    [installId, organizationId]
  );
  if (!rows[0]) return null;
  return getInstall(rows[0].id);
}

/** One live install, by id, narrowed to the business that claims it. */
export async function findCatalogInstall(
  organizationId: string,
  installId: string
): Promise<CatalogInstall | null> {
  const { rows } = await getPool().query<CatalogInstallRow>(
    `${INSTALL_SELECT} where ci.id = $1 and ci.organization_id = $2 and ci.removed_at is null`,
    [installId, organizationId]
  );
  return rows[0] ? toInstall(rows[0]) : null;
}

/**
 * Whether a business already has something live for this situation.
 *
 * Asked BEFORE activating, purely so the screen can say so — activation itself
 * does not depend on this, because the procedure it writes arrives switched off
 * and cannot collide. `procedures_one_active_per_intent` is what actually
 * refuses a second live procedure, at the moment somebody tries to switch this
 * one on.
 */
export async function activeProcedureFor(
  organizationId: string,
  intentCategory: string,
  language: string
): Promise<{ id: string; source: string } | null> {
  const { rows } = await getPool().query<{ id: string; source: string }>(
    `select id, source from procedures
      where organization_id = $1 and intent_category = $2 and language = $3 and is_active
      limit 1`,
    [organizationId, intentCategory, language]
  );
  return rows[0] ?? null;
}

export interface CatalogCounts {
  /** Published items on the shelf. */
  published: number;
  /** Live installs across every business. */
  installs: number;
  /** Businesses running at least one pack. */
  businesses: number;
  /** Live installs whose catalogue item has moved on since. */
  outdated: number;
  /** Live installs whose material has actually been added to the business. */
  activated: number;
}

export async function countCatalog(): Promise<CatalogCounts> {
  const { rows } = await getPool().query<{
    published: string;
    installs: string;
    businesses: string;
    outdated: string;
    activated: string;
  }>(
    `select (select count(*) from catalog_items where published_at is not null)::text as published,
            (select count(*) from catalog_installs where removed_at is null)::text    as installs,
            (select count(distinct organization_id)
               from catalog_installs where removed_at is null)::text                  as businesses,
            (select count(*)
               from catalog_installs ci
               join catalog_items it on it.id = ci.catalog_item_id
              where ci.removed_at is null
                and ci.installed_version < it.version)::text                          as outdated,
            (select count(*) from catalog_installs
              where removed_at is null and is_active)::text                           as activated`
  );
  return {
    published: Number(rows[0]?.published ?? 0),
    installs: Number(rows[0]?.installs ?? 0),
    businesses: Number(rows[0]?.businesses ?? 0),
    outdated: Number(rows[0]?.outdated ?? 0),
    activated: Number(rows[0]?.activated ?? 0),
  };
}
