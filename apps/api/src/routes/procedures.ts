import { Hono } from "hono";
import {
  findOrganizationBySlug,
  listProcedures,
  countProcedures,
  createOperatorProcedure,
  setProcedureActive,
  replaceProcedureSteps,
  acceptProposal,
  dismissProcedureSuggestion,
} from "@nexus/db";
import { INTENT_CATEGORIES, NON_PATTERN_INTENTS, parseProcedureSteps } from "@nexus/shared";
import {
  getInferenceReadiness,
  inferProceduresForBusiness,
  summarise,
} from "../services/procedure-inference.js";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * Procedural memory, per business (F10).
 *
 * MOUNTED UNDER /api/organizations/:slug ALONGSIDE KNOWLEDGE, WHICH IS THE
 * SUBSTANTIVE DECISION HERE, not a routing convenience.
 *
 * Two things follow from it. First, `requireTenantScope` and the tenant-context
 * middleware already apply, so every query below runs inside `withTenant` for
 * the named business and RLS is doing real work — rather than this being another
 * cross-tenant handler that must remember to narrow, which is the shape
 * /api/tasks and /api/operators have to carry a warning about.
 *
 * Second, it is reachable by that business's own staff, not only by a platform
 * operator. That is the same call already made for Knowledge, and for the same
 * reason: knowledge is what the agent answers FROM and procedures are the order
 * it answers IN, both are the business's own material, and the person who knows
 * whether "ask which country first" is right is the person who does the job. The
 * three operator-only screens are management information about staff — a
 * different thing.
 */
export const proceduresRoute = new Hono();

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

/** Situations a procedure may describe. Spam and "we could not tell" are not situations. */
const REVIEWABLE_INTENTS = INTENT_CATEGORIES.filter(
  (intent) => !NON_PATTERN_INTENTS.includes(intent)
);

proceduresRoute.get("/:slug/procedures", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const [procedures, counts, readiness] = await Promise.all([
    listProcedures(organization.id),
    countProcedures(organization.id),
    getInferenceReadiness(organization.id),
  ]);

  return c.json({
    procedures,
    counts,
    // Shipped with the list, not behind a second request. The empty state is the
    // state this screen will be in for most businesses on this platform for
    // months, and an empty list with no explanation reads as "broken" — the
    // exact mistake F5's `blockedBecause` exists to correct.
    readiness,
    intents: REVIEWABLE_INTENTS,
  });
});

/**
 * Run the writer now, for this business.
 *
 * The nightly job is the real mechanism; this exists because on the day the
 * feature ships there are no rows, no run has happened, and a screen that can
 * only say "come back tomorrow" cannot be judged by the person who has to judge
 * it. Same argument as /api/quality/refresh.
 *
 * Synchronous rather than queued, deliberately: the caller wants the result, and
 * a job id they must poll would need a progress UI to be worth anything. The
 * work is bounded — at most one model call per situation for one business.
 */
proceduresRoute.post("/:slug/procedures/infer", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json(
      { error: "No model is configured, so nothing can be inferred. Procedures can still be written by hand." },
      503
    );
  }

  try {
    const run = await inferProceduresForBusiness(
      organization.id,
      organization.slug,
      organization.name
    );
    logger.info({ business: organization.slug, ...summarise(run) }, "Procedure inference (manual)");
    // The per-intent outcomes go back whole, including the skips. "Looked at 3
    // kinds of enquiry, wrote nothing, here is why for each" is a result; a bare
    // count of 0 is indistinguishable from a broken run.
    return c.json({ run, summary: summarise(run) });
  } catch (err) {
    logger.error({ business: organization.slug, err }, "Manual procedure inference failed");
    return c.json({ error: "Could not look for procedures right now." }, 502);
  }
});

proceduresRoute.post("/:slug/procedures", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const intent = typeof body.intentCategory === "string" ? body.intentCategory : "";
  if (!REVIEWABLE_INTENTS.includes(intent as (typeof REVIEWABLE_INTENTS)[number])) {
    // Refused against the shared vocabulary rather than accepted as free text.
    // An intent spelled a second way does not produce a disagreement anyone can
    // see — it produces a procedure that is never found, because the classifier
    // will never write that string. Same argument as packages/shared/intents.ts.
    return c.json(
      { error: `"${intent}" is not one of the kinds of enquiry this platform classifies.` },
      400
    );
  }

  const parsed = parseProcedureSteps(body.steps);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    const procedure = await createOperatorProcedure({
      organizationId: organization.id,
      intentCategory: intent,
      language: typeof body.language === "string" && body.language ? body.language : "en",
      steps: parsed.steps,
      activate: body.activate === true,
      reviewedBy: scopeOf(c).sub,
    });
    return c.json({ procedure }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save that procedure.";
    logger.warn({ business: organization.slug, err }, "Procedure creation refused");
    return c.json({ error: message }, 400);
  }
});

/**
 * The four things a reviewer can do.
 *
 * One endpoint rather than four, because they share every guard and the client's
 * real question is "what should this procedure look like now". Note there is no
 * DELETE: a procedure that was once active is the record of how this business
 * answered its customers for a while, and migration 034 grants no delete to the
 * application role precisely so that stays true.
 */
proceduresRoute.patch("/:slug/procedures/:id", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const reviewer = scopeOf(c).sub;

  try {
    let procedure = null;

    if (body.accept === true) {
      procedure = await acceptProposal(organization.id, id, reviewer);
      if (!procedure) {
        return c.json({ error: "There is no suggestion on that procedure to accept." }, 404);
      }
    }

    if (body.dismiss === true) {
      procedure = await dismissProcedureSuggestion(organization.id, id, reviewer);
      if (!procedure) {
        return c.json({ error: "There is nothing on that procedure to dismiss." }, 404);
      }
    }

    if (Array.isArray(body.steps)) {
      const parsed = parseProcedureSteps(body.steps);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      procedure = await replaceProcedureSteps(organization.id, id, parsed.steps, reviewer);
      if (!procedure) return c.json({ error: "That procedure is not available to change." }, 404);
    }

    // Applied last on purpose. Someone editing and activating in one request
    // means "switch on what I just wrote", and doing it the other way round
    // would briefly make the OLD steps live.
    if (typeof body.isActive === "boolean") {
      procedure = await setProcedureActive(organization.id, id, body.isActive, reviewer);
      if (!procedure) {
        return c.json({ error: "That procedure is already in that state." }, 409);
      }
    }

    if (!procedure) return c.json({ error: "Nothing to change." }, 400);
    return c.json({ procedure });
  } catch (err) {
    // These are written to be read by a person — "another procedure for this
    // kind of enquiry is already active" is a sentence someone can act on in one
    // click, where a 500 is not.
    const message = err instanceof Error ? err.message : "Could not update that procedure.";
    logger.warn({ business: organization.slug, id, err }, "Procedure update refused");
    return c.json({ error: message }, 400);
  }
});
