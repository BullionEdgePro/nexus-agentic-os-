import { Hono } from "hono";
import {
  findOrganizationBySlug,
  listPhrases,
  getPhrase,
  createPhrase,
  updatePhraseBody,
  setPhraseActive,
} from "@nexus/db";
import {
  PHRASE_MOMENTS,
  PHRASE_MOMENT_LABELS,
  PHRASE_MOMENT_BLURBS,
  checkPhraseBody,
  isPhraseMoment,
  unfilledPlaceholders,
} from "@nexus/shared";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * What this business says in its own words (migration 045).
 *
 * MOUNTED UNDER /api/organizations/:slug alongside Knowledge and Procedures,
 * and reachable by that business's own staff for the same reason: this is the
 * business's own material, not management information about it. The person who
 * knows whether "I'm looping in a specialist" is the right thing for a law firm
 * to say is the person who answers that firm's phone.
 *
 * Which also means the tenant middleware has already established the context,
 * so every query below runs inside `withTenant` and RLS is doing real work.
 *
 * THE ONE GUARD THAT IS NOT IN THE SCHEMA lives here: a phrase with an unfilled
 * `{{placeholder}}` may not be switched on. Catalogue wording ships with them —
 * the catalogue cannot know when a business opens — and unlike every other
 * stored string on this platform, this one is sent VERBATIM. An unfilled
 * placeholder is not a degraded reply; it is `we read messages from
 * {{open_time}}` arriving on a customer's phone at the moment the platform has
 * already admitted it cannot help them properly.
 *
 * Deliberately not a check constraint: a business may legitimately draft one
 * while filling it in. The rule is "cannot go live", not "cannot exist".
 */
export const phrasesRoute = new Hono();

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

phrasesRoute.get("/:slug/phrases", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const phrases = await listPhrases(organization.id);

  return c.json({
    phrases,
    // The vocabulary travels with the list, so the form cannot offer a moment
    // the server would refuse and the page never holds its own copy of this
    // list. Two lists in two applications is how the nav rail and the
    // operator-only guard drifted apart.
    moments: PHRASE_MOMENTS.map((moment) => ({
      moment,
      label: PHRASE_MOMENT_LABELS[moment],
      blurb: PHRASE_MOMENT_BLURBS[moment],
    })),
  });
});

phrasesRoute.post("/:slug/phrases", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const moment = typeof body.moment === "string" ? body.moment : "";
  if (!isPhraseMoment(moment)) {
    return c.json({ error: `"${moment}" is not a moment this platform speaks at.` }, 400);
  }

  const checked = checkPhraseBody(body.body);
  if (!checked.ok) return c.json({ error: checked.error }, 400);

  const phrase = await createPhrase({
    organizationId: organization.id,
    moment,
    language: typeof body.language === "string" && body.language ? body.language : "en",
    body: checked.body,
    reviewedBy: scopeOf(c).sub,
  });
  return c.json({ phrase }, 201);
});

phrasesRoute.patch("/:slug/phrases/:id", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const reviewer = scopeOf(c).sub;

  try {
    let phrase = null;

    if (typeof body.body === "string") {
      const checked = checkPhraseBody(body.body);
      if (!checked.ok) return c.json({ error: checked.error }, 400);
      phrase = await updatePhraseBody(organization.id, id, checked.body, reviewer);
      if (!phrase) return c.json({ error: "That phrase is not available to change." }, 404);
    }

    // Applied last, so "edit and switch on" means "switch on what I just
    // wrote" — the other order would briefly make the OLD wording live.
    if (typeof body.isActive === "boolean") {
      if (body.isActive) {
        const current = phrase ?? (await getPhrase(organization.id, id));
        if (!current) return c.json({ error: "That phrase is not available to change." }, 404);

        // THE GUARD. Refused at the only point that matters, and the message
        // names the placeholder so the fix is obvious rather than a hunt.
        const unfilled = unfilledPlaceholders(current.body);
        if (unfilled.length > 0) {
          logger.info(
            { business: organization.slug, id, unfilled },
            "Refused to activate a phrase with unfilled placeholders"
          );
          return c.json(
            {
              error:
                `This still has ${unfilled.join(" and ")} in it. That is sent to the customer ` +
                `exactly as written, so fill it in before switching it on.`,
            },
            400
          );
        }
      }

      phrase = await setPhraseActive(organization.id, id, body.isActive, reviewer);
      if (!phrase) return c.json({ error: "That phrase is already in that state." }, 409);
    }

    if (!phrase) return c.json({ error: "Nothing to change." }, 400);
    return c.json({ phrase });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not update that phrase.";
    logger.warn({ business: organization.slug, id, err }, "Phrase update refused");
    return c.json({ error: message }, 400);
  }
});
