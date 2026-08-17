import { getPool } from "./client.js";
import type { PhraseMoment } from "@nexus/shared";

/**
 * Authored agent wording, per business (migration 045).
 *
 * The two moments where this platform sets the model aside and sends a sentence
 * somebody wrote. Read 045 before changing anything here — in particular the
 * part about why this table is more dangerous than `procedures`: a procedure is
 * context the model reads, a phrase IS the message, sent verbatim at the moment
 * the platform has already decided it cannot answer properly.
 *
 * EVERY FUNCTION HERE ASSUMES A TENANT CONTEXT. `agent_phrases` is in
 * TENANT_SCOPED_TABLES, so an unwrapped call throws under strict rather than
 * quietly reading nothing. The reply path's caller must use `withServingTenant`
 * — on a shared number, reading as the number's owner returns no rows, and "this
 * business has no phrase" is indistinguishable from "RLS filtered them all out".
 * That exact mistake has already been made twice on this platform.
 */

export type PhraseSource = "operator" | "catalog";

export interface AgentPhrase {
  id: string;
  organizationId: string;
  moment: PhraseMoment;
  language: string;
  body: string;
  source: PhraseSource;
  catalogInstallId: string | null;
  isActive: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
}

interface PhraseRow {
  id: string;
  organization_id: string;
  moment: PhraseMoment;
  language: string;
  body: string;
  source: PhraseSource;
  catalog_install_id: string | null;
  is_active: boolean;
  reviewed_at: string | null;
  reviewed_by: string | null;
  updated_at: string;
}

const toPhrase = (row: PhraseRow): AgentPhrase => ({
  id: row.id,
  organizationId: row.organization_id,
  moment: row.moment,
  language: row.language,
  body: row.body,
  source: row.source,
  catalogInstallId: row.catalog_install_id,
  isActive: row.is_active,
  reviewedAt: row.reviewed_at,
  reviewedBy: row.reviewed_by,
  updatedAt: row.updated_at,
});

const SELECT = `
  select id, organization_id, moment, language, body, source, catalog_install_id,
         is_active, reviewed_at, reviewed_by, updated_at
    from agent_phrases
`;

/**
 * THE ONE FUNCTION HERE THAT RUNS ON THE LIVE REPLY PATH.
 *
 * One indexed read that returns null for almost every call, because almost no
 * business has written a phrase. Null means "use the platform default", which
 * is the hardcoded constant the processor has always sent — so the absence of a
 * row is a complete answer rather than a degraded one.
 *
 * Active only. A draft is wording nobody has agreed to send, and this is the
 * function that would put it in front of a customer.
 */
export async function getActivePhrase(
  organizationId: string,
  moment: PhraseMoment,
  language = "en"
): Promise<AgentPhrase | null> {
  const { rows } = await getPool().query<PhraseRow>(
    `${SELECT}
      where organization_id = $1 and moment = $2 and language = $3 and is_active
      limit 1`,
    [organizationId, moment, language]
  );
  return rows[0] ? toPhrase(rows[0]) : null;
}

export async function listPhrases(organizationId: string): Promise<AgentPhrase[]> {
  const { rows } = await getPool().query<PhraseRow>(
    `${SELECT}
      where organization_id = $1
      order by moment asc, is_active desc, updated_at desc`,
    [organizationId]
  );
  return rows.map(toPhrase);
}

export async function getPhrase(
  organizationId: string,
  id: string
): Promise<AgentPhrase | null> {
  const { rows } = await getPool().query<PhraseRow>(
    `${SELECT} where organization_id = $1 and id = $2`,
    [organizationId, id]
  );
  return rows[0] ? toPhrase(rows[0]) : null;
}

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

const ALREADY_ACTIVE =
  "Another phrase for this moment is already switched on. Turn that one off first — two " +
  "sentences for one moment is a coin toss the customer cannot see.";

export async function createPhrase(input: {
  organizationId: string;
  moment: PhraseMoment;
  language: string;
  body: string;
  reviewedBy: string;
}): Promise<AgentPhrase> {
  const { rows } = await getPool().query<{ id: string }>(
    // Never active on creation. Even wording somebody just typed is worth
    // reading once more in the shape it will be sent before it is sent.
    `insert into agent_phrases
       (organization_id, moment, language, body, source, is_active, reviewed_at, reviewed_by)
     values ($1, $2, $3, $4, 'operator', false, now(), $5)
     returning id`,
    [input.organizationId, input.moment, input.language, input.body, input.reviewedBy]
  );
  const created = await getPhrase(input.organizationId, rows[0].id);
  if (!created) throw new Error("The phrase was written but could not be read back.");
  return created;
}

export async function updatePhraseBody(
  organizationId: string,
  id: string,
  body: string,
  reviewedBy: string
): Promise<AgentPhrase | null> {
  const { rows } = await getPool().query<{ id: string }>(
    // Editing makes it this business's own, whoever first wrote it — the same
    // call 033 makes when somebody rewrites an inferred procedure. Wording that
    // arrived from the catalogue and has since been rewritten is not catalogue
    // wording any more, and labelling it so would misreport where the sentence
    // a customer read came from.
    `update agent_phrases
        set body = $3, source = 'operator', reviewed_at = now(), reviewed_by = $4,
            updated_at = now()
      where organization_id = $1 and id = $2
      returning id`,
    [organizationId, id, body, reviewedBy]
  );
  if (!rows[0]) return null;
  return getPhrase(organizationId, id);
}

/**
 * Switch one on or off.
 *
 * The partial unique index refuses a second active phrase for the moment, and
 * the violation is turned into a sentence rather than a 500 — its real meaning,
 * "you already have one of these", is knowable and fixable in one click.
 *
 * NOTE WHAT IS NOT CHECKED HERE: unfilled placeholders. That guard lives in the
 * route, because it needs to name the placeholder in the message and because
 * this function is also how a phrase is switched OFF — and refusing to switch
 * off a phrase with a placeholder in it would trap a business with
 * `{{open_time}}` live and no way to stop it.
 */
export async function setPhraseActive(
  organizationId: string,
  id: string,
  isActive: boolean,
  reviewedBy: string
): Promise<AgentPhrase | null> {
  try {
    const { rows } = await getPool().query<{ id: string }>(
      `update agent_phrases
          set is_active = $3, reviewed_at = now(), reviewed_by = $4, updated_at = now()
        where organization_id = $1 and id = $2 and is_active <> $3
        returning id`,
      [organizationId, id, isActive, reviewedBy]
    );
    if (!rows[0]) return null;
    return getPhrase(organizationId, id);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new Error(ALREADY_ACTIVE);
    throw err;
  }
}

/**
 * Write the phrase a catalogue template becomes.
 *
 * Idempotent by the unique index on `catalog_install_id` (045) rather than by a
 * read-then-write, same as procedures. Arrives switched off and, because
 * catalogue wording ships with `{{placeholders}}` in it, will stay off until a
 * person fills them in — the route refuses to activate one that still has any.
 */
export async function materialisePhrase(input: {
  organizationId: string;
  installId: string;
  moment: PhraseMoment;
  language: string;
  body: string;
}): Promise<{ phraseId: string; created: boolean }> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into agent_phrases
       (organization_id, moment, language, body, source, is_active, catalog_install_id)
     values ($1, $2, $3, $4, 'catalog', false, $5)
     on conflict (catalog_install_id) where catalog_install_id is not null
       do nothing
     returning id`,
    [input.organizationId, input.moment, input.language, input.body, input.installId]
  );
  if (rows[0]) return { phraseId: rows[0].id, created: true };

  const { rows: existing } = await getPool().query<{ id: string }>(
    `select id from agent_phrases where catalog_install_id = $1`,
    [input.installId]
  );
  if (!existing[0]) {
    throw new Error("The phrase was neither written nor found — refusing to report success.");
  }
  return { phraseId: existing[0].id, created: false };
}
