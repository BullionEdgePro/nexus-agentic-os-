import {
  materialiseProcedure,
  materialisePhrase,
  markInstallActivated,
  activeProcedureFor,
  findCatalogItemBySlug,
  findLinkedProcedure,
  findLinkedPhrase,
  proposeOrReplaceProcedureSteps,
  replaceCatalogPhraseBody,
  setInstalledVersion,
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

export type UpdateRefusal =
  | "already-current"
  | "rewritten-here"
  | "wording-is-live"
  | "unusable-payload"
  | "embedding-unavailable";

export type UpdateOutcome =
  | {
      ok: true;
      /** Null when the pack was installed but never added to the business. */
      kind: CatalogItem["kind"] | null;
      from: number;
      to: number;
      note: string;
    }
  | { ok: false; refusal: UpdateRefusal; message: string };

/**
 * Take a catalogue update into a business.
 *
 * THE RULE 039 WROTE AND THIS FUNCTION KEEPS: "an installed business keeps what
 * it installed until it CHOOSES to take an update: a catalogue that edits itself
 * inside somebody's live agent is a marketplace that changes what customers are
 * told without anyone deciding to." So this only ever runs from a button, never
 * from a sweep, and it refuses in the two cases where taking the update would
 * quietly discard something a person is responsible for.
 *
 * REFUSAL ONE — SOMEBODY REWROTE IT HERE. Both `procedures` and `agent_phrases`
 * flip `source` to 'operator' the moment a person edits by hand. A row still
 * reading 'catalog' is untouched since it arrived; one reading 'operator' is
 * somebody's own work, and overwriting it with a newer generic version is the
 * catalogue outranking the business about its own material. F10 makes the same
 * call in the other direction — its rule 3 has the inference writer defer
 * entirely to an operator-written procedure.
 *
 * REFUSAL TWO — THE WORDING IS LIVE. A phrase is sent verbatim, and there is no
 * `proposed_body` slot to park a suggestion in the way a procedure has
 * `proposed_steps`. Replacing a live sentence would change what customers read
 * with nobody having seen the new one. So it says to switch it off first, which
 * is one extra click and no surprise.
 *
 * A procedure needs no such refusal, because the slot exists: an ACTIVE one is
 * proposed to rather than edited, and the suggestion appears on "How we answer"
 * beside the version it would replace.
 */
export async function takeInstallUpdate(
  organizationId: string,
  install: CatalogInstall
): Promise<UpdateOutcome> {
  const item = await findCatalogItemBySlug(install.itemSlug);
  if (!item) {
    return { ok: false, refusal: "unusable-payload", message: "That catalogue item no longer exists." };
  }

  const from = install.installedVersion;
  const to = item.version;
  if (from >= to) {
    return {
      ok: false,
      refusal: "already-current",
      message: `This business is already running v${from}, which is the current version.`,
    };
  }

  // Installed but never added to the business: there is no copy to reconcile,
  // so taking the update is only a change of which version a later Add would
  // write. Handled first, because every branch below assumes a linked row.
  if (!install.isActive) {
    await setInstalledVersion(organizationId, install.id, to);
    return {
      ok: true,
      kind: null,
      from,
      to,
      note: `Now recorded as v${to}. Nothing was added to this business, so nothing changed for customers — adding it will use the newer version.`,
    };
  }

  if (item.kind === "procedure") {
    const linked = await findLinkedProcedure(install.id);
    if (!linked) {
      return {
        ok: false,
        refusal: "unusable-payload",
        message: "This install is marked as added, but no procedure is linked to it.",
      };
    }
    if (linked.source !== "catalog") {
      return {
        ok: false,
        refusal: "rewritten-here",
        message:
          "Somebody has rewritten this procedure since it arrived, so it is this business's own now. " +
          "Taking the update would discard their version.",
      };
    }

    const { intent, parsed } = procedurePayload(item);
    if (!INTENT_CATEGORIES.includes(intent as (typeof INTENT_CATEGORIES)[number]) || !parsed.ok) {
      return {
        ok: false,
        refusal: "unusable-payload",
        message: parsed.ok ? `"${intent}" is not a kind of enquiry this platform classifies.` : parsed.error,
      };
    }

    const effect = await proposeOrReplaceProcedureSteps(
      organizationId,
      linked.id,
      linked.isActive,
      parsed.steps
    );
    await setInstalledVersion(organizationId, install.id, to);
    logger.info({ organizationId, item: item.slug, from, to, effect }, "Catalogue update taken");

    return {
      ok: true,
      kind: "procedure",
      from,
      to,
      note:
        effect === "proposed"
          ? `v${to} is waiting on How we answer as a suggested change. The live procedure is untouched until somebody accepts it — it was switched on, and a version nobody read must not replace one somebody approved.`
          : `Updated to v${to} in How we answer. It was switched off, so nothing changed for customers.`,
    };
  }

  if (item.kind === "template") {
    const linked = await findLinkedPhrase(install.id);
    if (!linked) {
      return {
        ok: false,
        refusal: "unusable-payload",
        message: "This install is marked as added, but no phrase is linked to it.",
      };
    }
    if (linked.source !== "catalog") {
      return {
        ok: false,
        refusal: "rewritten-here",
        message:
          "Somebody has rewritten this wording since it arrived, so it is this business's own now. " +
          "Taking the update would discard their version.",
      };
    }
    if (linked.isActive) {
      return {
        ok: false,
        refusal: "wording-is-live",
        message:
          "This wording is being sent to customers right now, and there is nowhere to park a new " +
          "version for review the way a procedure has. Switch it off in What we say, take the " +
          "update, read it, then switch it back on.",
      };
    }

    const checked = checkPhraseBody(item.payload?.body);
    if (!checked.ok) return { ok: false, refusal: "unusable-payload", message: checked.error };

    await replaceCatalogPhraseBody(organizationId, linked.id, checked.body);
    await setInstalledVersion(organizationId, install.id, to);

    const unfilled = unfilledPlaceholders(checked.body);
    logger.info({ organizationId, item: item.slug, from, to, unfilled }, "Catalogue update taken");

    return {
      ok: true,
      kind: "template",
      from,
      to,
      note: unfilled.length
        ? `Updated to v${to} in What we say, still switched off. The new wording has ${unfilled.join(" and ")} in it, so it cannot be switched on until that is filled in.`
        : `Updated to v${to} in What we say, still switched off. Read it before switching it on — it is not the sentence you last approved.`,
    };
  }

  // knowledge_pack — no active/inactive state and no approved version to
  // preserve, so the update is simply a re-ingest. `ingestTextSource` is
  // idempotent by content hash against the same `catalog:<slug>` uri, so this
  // replaces the chunks rather than adding a second copy.
  if (item.payload?.guidance_only === true) {
    return { ok: false, refusal: "unusable-payload", message: GUIDANCE_REFUSAL };
  }

  const content = packContent(item);
  if (!content) {
    return { ok: false, refusal: "unusable-payload", message: "This pack has no documents with any content in them." };
  }

  try {
    const result = await ingestTextSource({
      organizationId,
      title: item.title,
      content,
      kind: "faq",
      uri: `catalog:${item.slug}`,
    });
    await setInstalledVersion(organizationId, install.id, to);
    logger.info({ organizationId, item: item.slug, from, to, chunks: result.chunks }, "Catalogue update taken");

    return {
      ok: true,
      kind: "knowledge_pack",
      from,
      to,
      note: result.skipped
        ? `Recorded as v${to}. The text was unchanged, so nothing was re-embedded.`
        : `Re-indexed at v${to}. A chunk has no switched-off state, so the agent is answering from the newer text now.`,
    };
  } catch (err) {
    // The version is NOT bumped on this path. Recording v2 while the agent is
    // still answering from v1's chunks would make "what is this agent doing"
    // answered with a number that is true of nothing.
    logger.error({ organizationId, item: item.slug, err }, "Catalogue update failed to re-index");
    return {
      ok: false,
      refusal: "embedding-unavailable",
      message:
        "Could not re-index this pack — the embedding service did not answer. Nothing changed, and " +
        "this business is still recorded as running v" + from + ", which is what it is running.",
    };
  }
}

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
