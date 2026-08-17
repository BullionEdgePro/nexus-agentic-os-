import {
  materialiseProcedure,
  materialisePhrase,
  markInstallActivated,
  activeProcedureFor,
  findCatalogItemBySlug,
  type CatalogInstall,
  type CatalogItem,
} from "@nexus/db";
import { ingestTextSource } from "@nexus/knowledge";
import {
  INTENT_CATEGORIES,
  parseProcedureSteps,
  checkPhraseBody,
  isPhraseMoment,
  unfilledPlaceholders,
} from "@nexus/shared";
import { logger } from "../lib/logger.js";

/**
 * Activation — turning an installed pack into the business's own material.
 *
 * Lives in the API rather than in packages/db for one structural reason:
 * knowledge packs are ingested through `@nexus/knowledge`, which depends on
 * `@nexus/db`. Putting this in the db package would close a dependency cycle.
 * Same shape as services/procedure-inference.ts.
 *
 * WHAT ACTIVATION DOES AND DOES NOT DO. It materialises; it does not switch on.
 * A procedure arrives in "How we answer" switched off, and a person turns it on
 * there — the screen built for that decision, which already shows what else is
 * active for the same situation and already refuses two at once. A catalogue
 * click that went straight into the live prompt would be the one thing 039's
 * design exists to prevent.
 *
 * Knowledge is the exception, and it is worth naming rather than glossing:
 * there is no inactive state for a knowledge chunk. Once embedded it is in the
 * pool retrieval searches, so activating a knowledge pack DOES change what the
 * agent can answer from, immediately. That is how the Knowledge screen already
 * behaves for anything a person adds by hand, so it is consistent rather than
 * novel — but the caller is told, and the page says it, because "the procedure
 * one is switched off" would otherwise be read as covering both.
 */

export type ActivationRefusal =
  | "no-moment"
  | "guidance-only"
  | "unusable-payload"
  | "embedding-unavailable";

export type ActivationOutcome =
  | {
      ok: true;
      kind: "procedure";
      procedureId: string;
      /** False when it was already activated. Not an error — see below. */
      created: boolean;
      /** Something else is already live for this situation, so switching this on will be refused. */
      blockedBySource: string | null;
      note: string;
    }
  | {
      ok: true;
      kind: "template";
      phraseId: string;
      created: boolean;
      /** Placeholders still to fill. Non-empty means it cannot be switched on yet. */
      unfilled: string[];
      note: string;
    }
  | {
      ok: true;
      kind: "knowledge_pack";
      sourceId: string;
      chunks: number;
      skipped: boolean;
      note: string;
    }
  | { ok: false; refusal: ActivationRefusal; message: string };

/**
 * Catalogue wording now has somewhere to go: `agent_phrases` (migration 045).
 *
 * It is emphatically NOT `message_templates`. That table is a MIRROR OF META
 * (017) — `status` is Meta's verbatim answer and the file exists because a
 * locally-typed approval "records what they believed rather than what is true",
 * producing "a bulk send that fails at the last hop, after the broadcast row,
 * the recipient rows and the queue jobs all exist". These items were never
 * Meta marketing templates; they are the sentences the platform sends when it
 * sets the model aside, and 045 gave those a per-business home.
 *
 * A template must therefore name WHICH moment it is wording for. The catalogue
 * payload carries `moment`, checked against the shared vocabulary — wording
 * filed under a moment nothing detects is a phrase that is stored, visible,
 * switched on, and never sent.
 */
const NO_MOMENT_REFUSAL =
  "This wording does not say which moment it is for, so there is nowhere to file it. " +
  "The platform speaks in its own words at two moments — handing over to a colleague, " +
  "and having nobody to hand to — and a phrase has to name one of them.";

const GUIDANCE_REFUSAL =
  "This pack is a checklist for a person, not material for the agent — its entries are " +
  "questions, not answers. Indexing it would put nine questions into what the agent " +
  "answers from, and the knowledge base would look fuller than it is. Read it and fill " +
  "the gaps in Knowledge instead.";

function procedurePayload(item: CatalogItem) {
  const payload = item.payload ?? {};
  const intent = typeof payload.intent_category === "string" ? payload.intent_category : "";
  const parsed = parseProcedureSteps(payload.steps);
  return { intent, parsed };
}

/** Documents joined into one source, in order, each under its own heading. */
function packContent(item: CatalogItem): string {
  const documents = Array.isArray(item.payload?.documents)
    ? (item.payload.documents as { title?: string; body?: string }[])
    : [];
  return documents
    .filter((doc) => typeof doc.body === "string" && doc.body.trim())
    .map((doc) => `${doc.title ?? ""}\n${doc.body}`.trim())
    .join("\n\n");
}

export async function activateInstall(
  organizationId: string,
  install: CatalogInstall
): Promise<ActivationOutcome> {
  const item = await findCatalogItemBySlug(install.itemSlug);
  if (!item) {
    return {
      ok: false,
      refusal: "unusable-payload",
      message: "That catalogue item no longer exists.",
    };
  }

  if (item.kind === "template") {
    const payload = item.payload ?? {};
    const moment = typeof payload.moment === "string" ? payload.moment : "";
    if (!isPhraseMoment(moment)) {
      return { ok: false, refusal: "no-moment", message: NO_MOMENT_REFUSAL };
    }

    const checked = checkPhraseBody(payload.body);
    if (!checked.ok) return { ok: false, refusal: "unusable-payload", message: checked.error };

    const written = await materialisePhrase({
      organizationId,
      installId: install.id,
      moment,
      language: item.language,
      body: checked.body,
    });

    // Named on the way out, not discovered on the way in. Catalogue wording
    // ships with `{{open_time}}` because the catalogue cannot know when a
    // business opens, and this text is sent VERBATIM — so the person who just
    // pressed Add is told, now, that there is a blank to fill before it can go
    // live. Finding that out later by being refused at the switch would be a
    // worse version of the same conversation.
    const unfilled = unfilledPlaceholders(checked.body);

    await markInstallActivated(organizationId, install.id);
    logger.info(
      { organizationId, item: item.slug, phraseId: written.phraseId, unfilled },
      "Catalogue wording activated"
    );

    return {
      ok: true,
      kind: "template",
      phraseId: written.phraseId,
      created: written.created,
      unfilled,
      note: unfilled.length
        ? `Added to What we say, switched off. It still has ${unfilled.join(" and ")} in it — ` +
          `that goes to the customer exactly as written, so fill it in before switching it on.`
        : written.created
          ? "Added to What we say, switched off. Nothing changes until somebody turns it on there."
          : "Already added to What we say. Nothing was written twice.",
    };
  }

  if (item.kind === "procedure") {
    const { intent, parsed } = procedurePayload(item);
    // Checked against the shared vocabulary, not accepted as free text. An
    // intent spelled a second way produces a procedure the classifier will
    // never look up — findable by nobody, wrong in no visible way.
    if (!INTENT_CATEGORIES.includes(intent as (typeof INTENT_CATEGORIES)[number])) {
      return {
        ok: false,
        refusal: "unusable-payload",
        message: `This pack names "${intent || "no"}" as its kind of enquiry, which this platform does not classify.`,
      };
    }
    if (!parsed.ok) {
      return { ok: false, refusal: "unusable-payload", message: parsed.error };
    }

    const written = await materialiseProcedure({
      organizationId,
      installId: install.id,
      intentCategory: intent,
      language: item.language,
      steps: parsed.steps,
    });

    // Reported, not enforced. The row we just wrote is switched off and cannot
    // collide; this is so the screen can say "you will have to turn the other
    // one off first" now rather than let somebody discover it two clicks later.
    const blocking = await activeProcedureFor(organizationId, intent, item.language);

    await markInstallActivated(organizationId, install.id);
    logger.info(
      { organizationId, item: item.slug, procedureId: written.procedureId, created: written.created },
      "Catalogue procedure activated"
    );

    return {
      ok: true,
      kind: "procedure",
      procedureId: written.procedureId,
      created: written.created,
      blockedBySource: blocking?.source ?? null,
      note: written.created
        ? "Added to How we answer, switched off. Nothing changes for customers until somebody turns it on there."
        : "Already added to How we answer. Nothing was written twice.",
    };
  }

  // knowledge_pack
  if (item.payload?.guidance_only === true) {
    return { ok: false, refusal: "guidance-only", message: GUIDANCE_REFUSAL };
  }

  const content = packContent(item);
  if (!content) {
    return {
      ok: false,
      refusal: "unusable-payload",
      message: "This pack has no documents with any content in them.",
    };
  }

  try {
    const result = await ingestTextSource({
      organizationId,
      title: item.title,
      content,
      kind: "faq",
      // A stable identity so re-activating matches the same source rather than
      // creating a second copy. `ingestTextSource` keys on uri first and falls
      // back to title only when there is none — and a title is exactly the
      // thing that changes when the catalogue reworks an item.
      uri: `catalog:${item.slug}`,
    });

    await markInstallActivated(organizationId, install.id);
    logger.info(
      { organizationId, item: item.slug, sourceId: result.sourceId, chunks: result.chunks },
      "Catalogue knowledge pack activated"
    );

    return {
      ok: true,
      kind: "knowledge_pack",
      sourceId: result.sourceId,
      chunks: result.chunks,
      skipped: result.skipped,
      note: result.skipped
        ? "Already indexed and unchanged, so nothing was re-embedded."
        : "Indexed into Knowledge. Unlike a procedure this is live immediately — a chunk has no switched-off state, so the agent can answer from it now.",
    };
  } catch (err) {
    // Embeddings are a single external dependency with no fallback. A failure
    // here must leave the install UNACTIVATED rather than marked done, or the
    // screen would report material the agent cannot actually retrieve — which
    // is the plausible-normal-state failure this platform keeps producing.
    logger.error({ organizationId, item: item.slug, err }, "Catalogue pack activation failed");
    return {
      ok: false,
      refusal: "embedding-unavailable",
      message:
        "Could not index this pack — the embedding service did not answer. Nothing was added, " +
        "so this can be tried again; it has not been half-applied.",
    };
  }
}
