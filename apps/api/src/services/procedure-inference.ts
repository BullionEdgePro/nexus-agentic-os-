import {
  getPool,
  listOrganizations,
  upsertInferredProcedure,
  withAllTenants,
  withTenant,
  type InferenceWrite,
} from "@nexus/db";
import { completeText } from "@nexus/agents";
import { scanForPii } from "@nexus/governance";
import {
  NON_PATTERN_INTENTS,
  MAX_PROCEDURE_STEPS,
  MAX_STEP_CHARS,
  parseProcedureSteps,
  type ProcedureStep,
} from "@nexus/shared";
import { logger } from "../lib/logger.js";
import { activateWellEvidencedProcedures } from "./self-improvement.js";

/**
 * The inference writer (F10).
 *
 * Migration 033 built the table and deliberately left it empty: "Schema and
 * isolation first, so the boundary exists before anything can cross it." This is
 * the thing that crosses it — the first feature on this platform that changes
 * HOW the agent answers rather than what it knows.
 *
 * It reads conversations the agent handled to the end, and asks what order of
 * work they have in common. That order, once a person switches it on, becomes
 * the shape of every future reply about that kind of enquiry. Which is why
 * almost all of the code below is about what it refuses to do.
 *
 * ------------------------------------------------------------
 * WHAT "ENDED WELL" ACTUALLY MEANS HERE, INCLUDING WHAT IT DOES NOT
 * ------------------------------------------------------------
 *
 * There is no thumbs-up on WhatsApp. Nobody tells this platform that a
 * conversation went well, so "well handled" has to be assembled out of what
 * people did — the same principle F14 works on: every figure comes from an
 * action a person took, never from the agent's own assessment of its answers,
 * which rises with fluency and says nothing about whether anyone was helped.
 *
 * The evidence used is:
 *
 *   no human joined      — a colleague taking over is the clearest available
 *                          signal that the agent was not managing
 *   the agent replied    — otherwise there is no agent behaviour to learn from
 *   two or more inbound  — one "hi" answered by a menu is not a method
 *   the customer came
 *   back AFTER the reply — they read the answer and continued, rather than
 *                          reading it and leaving
 *   settled for a day    — an open conversation can still escalate tomorrow,
 *                          and learning from it early would learn the wrong end
 *
 * NOW THE HONEST PART: none of that is success. A customer who gave up and
 * bought elsewhere leaves exactly the same trace as one who was helped —
 * silence. This writer cannot tell them apart and does not claim to, which is
 * the whole reason its output is a SUGGESTION that ships switched off. The
 * review screen says this in as many words; if that sentence is ever dropped
 * from the UI, this feature starts asserting something it cannot know.
 *
 * ------------------------------------------------------------
 * WHY THE OUTPUT IS SCRUBBED EVEN THOUGH THE INPUT IS THE BUSINESS'S OWN
 * ------------------------------------------------------------
 *
 * The transcripts belong to the business whose procedure this is, so nothing
 * here crosses a tenant boundary — 033 keeps that guarantee in the schema. The
 * risk is different in kind: a procedure goes into the agent's prompt for EVERY
 * future customer of that business. A step that reads "quote AED 350 as we did
 * for Mr Haddad's Syrian degree certificate" would take one customer's affairs
 * and repeat them to strangers, indefinitely, in a row labelled "how we work".
 *
 * So the model is told to write generically, and then — because an instruction
 * is not a guarantee — the output is checked against the PII scanner and against
 * the names of the very people whose conversations produced it. A failed check
 * throws the whole inference away rather than editing it: a half-scrubbed
 * procedure is a procedure whose remaining specifics nobody has looked at.
 */

/**
 * Below this, an inference is a description of a few conversations rather than
 * a method.
 *
 * Five, matching the spirit of the thresholds F5 and F14 already use
 * (`minSamples`, `minConversations`): a rate or a pattern computed from three
 * examples swings wildly and reads as a trend. Here the stakes are higher than
 * a chart — one conversation generalised into a procedure would encode one
 * customer's circumstances as the way this business works.
 */
export const MIN_WELL_HANDLED_CONVERSATIONS = 5;

/**
 * How far back to look.
 *
 * Long, because this platform's traffic is thin — four of five businesses have
 * no customers yet — and a 7-day window would mean the feature never has enough
 * evidence to say anything. Not unlimited, because a procedure drawn from how
 * the business worked six months ago is archaeology.
 */
export const EVIDENCE_WINDOW_DAYS = 60;

/** A conversation is not over until it has been quiet for a day. */
const SETTLED_AFTER_HOURS = 24;

/**
 * Transcripts shown to the model per inference, and how much of each.
 *
 * Bounded three ways because an unbounded prompt is an unbounded bill, and
 * because the tenth example of the same exchange adds nothing the first six did
 * not. The most recent conversations are used: a method that changed last month
 * should show through rather than be averaged away.
 */
const MAX_TRANSCRIPTS = 6;
const MAX_TURNS_PER_TRANSCRIPT = 14;
const MAX_CHARS_PER_TURN = 240;

/**
 * Everything is labelled English, and that is a known simplification.
 *
 * `conversation_metrics` records no language, so F5's shared rollup carries the
 * tenant default with the same caveat written down beside it: "a wrong label
 * here would split one pattern into two that each look thinner than the truth."
 * The same choice is made here rather than a different one, because two
 * subsystems disagreeing about the language of the same conversation would be
 * worse than both being approximately wrong in the same direction. When
 * per-conversation language lands, both change together.
 */
const PROCEDURE_LANGUAGE = "en";

export interface WellHandledConversation {
  conversationId: string;
  intent: string;
  lastMessageAt: string;
}

/**
 * Conversations this writer is willing to learn from, for one business.
 *
 * The two aggregates are computed SEPARATELY and then joined on
 * conversation_id. Joining `messages` to `conversation_metrics` in one group-by
 * fans out — every message multiplied by every metric row — and the counts this
 * whole function turns on would silently inflate. `quality.ts` and
 * `shared-brain.ts` both collapse to one row per conversation first, for a
 * version of the same reason.
 */
export async function findWellHandledConversations(
  organizationId: string,
  windowDays = EVIDENCE_WINDOW_DAYS
): Promise<WellHandledConversation[]> {
  const { rows } = await getPool().query<{
    conversation_id: string;
    intent: string;
    last_at: string;
  }>(
    `with recent as (
       select m.conversation_id,
              count(*) filter (where m.sender_type = 'contact')     as inbound,
              count(*) filter (where m.sender_type = 'ai_agent')    as ai,
              count(*) filter (where m.sender_type = 'human_agent') as human,
              max(m.created_at)                                     as last_at,
              min(m.created_at) filter (where m.sender_type = 'ai_agent') as first_ai_at,
              max(m.created_at) filter (where m.sender_type = 'contact')  as last_inbound_at
         from messages m
        where m.serving_organization_id = $1
          and m.created_at > now() - ($2::integer * interval '1 day')
        group by m.conversation_id
     ),
     labelled as (
       select conversation_id, min(intent) as intent
         from conversation_metrics
        where serving_organization_id = $1
          and intent is not null
        group by conversation_id
     )
     select r.conversation_id, l.intent, r.last_at
       from recent r
       join labelled l on l.conversation_id = r.conversation_id
      -- unknown is the absence of a category and inbound_pitch is spam. A
      -- procedure for either would be a method for answering nobody, and on
      -- this number inbound pitches are the single largest share of traffic —
      -- so without this exclusion they would be the first procedure the system
      -- ever proposed. Same list, same argument, as the F5 rollup.
      where l.intent <> all($3::text[])
        and r.human = 0
        and r.ai > 0
        and r.inbound >= 2
        and r.last_inbound_at > r.first_ai_at
        and r.last_at < now() - ($4::integer * interval '1 hour')
      order by r.last_at desc`,
    [organizationId, windowDays, NON_PATTERN_INTENTS, SETTLED_AFTER_HOURS]
  );

  return rows.map((row) => ({
    conversationId: row.conversation_id,
    intent: row.intent,
    lastMessageAt: row.last_at,
  }));
}

export interface IntentEvidence {
  intent: string;
  wellHandled: number;
  enough: boolean;
}

export interface InferenceReadiness {
  windowDays: number;
  minConversations: number;
  /** Conversations with any traffic in the window. */
  conversations: number;
  /** Of those, the ones this writer will learn from. */
  wellHandled: number;
  perIntent: IntentEvidence[];
  /** Plain-language reason there is nothing to propose, or null. */
  blockedBecause: string | null;
  /** False when no model key is configured — the writer cannot run at all. */
  canRun: boolean;
}

/**
 * Why this business has no procedures yet.
 *
 * Exists because of the mistake F5 made and then wrote down: an empty store and
 * a broken one look identical, and "nothing here" sends a reader off to wait for
 * something that may never be the constraint. The Neural Brain looked like it
 * was waiting for a second tenant while it was actually unable to read
 * five-sixths of the traffic it had.
 *
 * So the review screen gets a sentence rather than an absence, and the reasons
 * are ordered by which constraint actually binds first.
 */
export async function getInferenceReadiness(
  organizationId: string,
  windowDays = EVIDENCE_WINDOW_DAYS
): Promise<InferenceReadiness> {
  const [{ rows: totals }, wellHandled] = await Promise.all([
    getPool().query<{ conversations: string }>(
      `select count(distinct conversation_id)::text as conversations
         from messages
        where serving_organization_id = $1
          and created_at > now() - ($2::integer * interval '1 day')`,
      [organizationId, windowDays]
    ),
    findWellHandledConversations(organizationId, windowDays),
  ]);

  const conversations = Number(totals[0]?.conversations ?? 0);

  const byIntent = new Map<string, number>();
  for (const row of wellHandled) {
    byIntent.set(row.intent, (byIntent.get(row.intent) ?? 0) + 1);
  }
  const perIntent: IntentEvidence[] = [...byIntent.entries()]
    .map(([intent, count]) => ({
      intent,
      wellHandled: count,
      enough: count >= MIN_WELL_HANDLED_CONVERSATIONS,
    }))
    .sort((a, b) => b.wellHandled - a.wellHandled);

  const canRun = Boolean(process.env.ANTHROPIC_API_KEY);

  let blockedBecause: string | null = null;
  if (!canRun) {
    blockedBecause =
      "No model key is configured, so nothing can be inferred. Procedures can still be written by hand.";
  } else if (conversations === 0) {
    blockedBecause = `This business has handled no conversations in the last ${windowDays} days, so there is nothing to learn from.`;
  } else if (wellHandled.length === 0) {
    blockedBecause =
      "Conversations exist, but none of them ended with the agent handling it alone and the customer still replying — which is the only evidence this looks at. That is a fact about the traffic, not a fault.";
  } else if (!perIntent.some((intent) => intent.enough)) {
    const best = perIntent[0];
    blockedBecause = `The strongest case so far is ${best.wellHandled} conversation${
      best.wellHandled === 1 ? "" : "s"
    } about ${best.intent.replace(/_/g, " ")}; ${MIN_WELL_HANDLED_CONVERSATIONS} are needed before a handful of conversations counts as a method.`;
  }

  return {
    windowDays,
    minConversations: MIN_WELL_HANDLED_CONVERSATIONS,
    conversations,
    wellHandled: wellHandled.length,
    perIntent,
    blockedBecause,
    canRun,
  };
}

interface Transcript {
  conversationId: string;
  contactName: string | null;
  turns: { who: "Customer" | "Us"; body: string }[];
}

async function loadTranscripts(conversationIds: string[]): Promise<Transcript[]> {
  const { rows } = await getPool().query<{
    conversation_id: string;
    sender_type: string;
    body: string;
    contact_name: string | null;
  }>(
    `select m.conversation_id, m.sender_type, m.body, c.display_name as contact_name
       from messages m
       left join contacts c on c.id = m.contact_id
      where m.conversation_id = any($1::uuid[])
        and m.body is not null
        and m.body <> ''
      order by m.conversation_id, m.created_at asc`,
    [conversationIds]
  );

  const byConversation = new Map<string, Transcript>();
  for (const row of rows) {
    let transcript = byConversation.get(row.conversation_id);
    if (!transcript) {
      transcript = { conversationId: row.conversation_id, contactName: null, turns: [] };
      byConversation.set(row.conversation_id, transcript);
    }
    if (row.contact_name) transcript.contactName = row.contact_name;
    // System messages are platform bookkeeping ("handed to a colleague"), not
    // part of the method the agent followed.
    if (row.sender_type !== "contact" && row.sender_type !== "ai_agent") continue;
    transcript.turns.push({
      who: row.sender_type === "contact" ? "Customer" : "Us",
      body: row.body.slice(0, MAX_CHARS_PER_TURN),
    });
  }

  return [...byConversation.values()].map((transcript) => ({
    ...transcript,
    // The OPENING turns, not the last ones. A procedure is an order of work, and
    // the order is established at the start; truncating from the front would
    // teach the writer that every enquiry begins with a closing pleasantry.
    turns: transcript.turns.slice(0, MAX_TURNS_PER_TRANSCRIPT),
  }));
}

/**
 * The one part of this file that is a judgement rather than a rule.
 *
 * Written as a strict instruction with an explicit way out — returning no steps
 * at all. Without that, a model asked "what is the common method here?" will
 * always find one, and six unrelated conversations would become a confident
 * four-step procedure that no customer's enquiry ever actually followed.
 */
function buildPrompt(businessName: string, intent: string, transcripts: Transcript[]): string {
  const body = transcripts
    .map(
      (transcript, index) =>
        `Conversation ${index + 1}:\n` +
        transcript.turns.map((turn) => `${turn.who}: ${turn.body}`).join("\n")
    )
    .join("\n\n");

  return (
    `${businessName} handles enquiries of this kind: ${intent.replace(/_/g, " ")}.\n\n` +
    `Below are ${transcripts.length} conversations its assistant handled without a colleague ` +
    `stepping in.\n\n${body}\n\n` +
    `Write the ORDER OF WORK these conversations have in common — what to establish first, ` +
    `then next, then what to offer — so the assistant can follow the same order next time.\n\n` +
    `Rules:\n` +
    `- Reply with JSON only: {"steps": ["...", "..."]}. No preamble, no code fence.\n` +
    `- At most ${MAX_PROCEDURE_STEPS} steps. Each an instruction in the imperative, under ` +
    `${MAX_STEP_CHARS} characters.\n` +
    `- Describe the method, never the conversations. No customer names, phone numbers, ` +
    `companies, countries, document titles, case details, prices or dates. If a step can only ` +
    `be written by referring to one particular conversation, leave it out.\n` +
    `- Do not invent good practice. Only write down what these conversations actually did.\n` +
    `- If they do not share a method, reply {"steps": []}. That is a useful answer, not a failure.`
  );
}

/** Extract the JSON object a model wrapped in prose or a code fence. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Names of the people whose conversations produced this, lowercased, in pieces.
 *
 * Split into parts so a step naming only a first name is caught — that is the
 * likelier leak, and the one a whole-string check would miss. Short fragments
 * are dropped: a two-letter name matches inside ordinary words and would refuse
 * every inference forever, which is its own kind of failure.
 */
function nameFragments(transcripts: Transcript[]): string[] {
  const fragments = new Set<string>();
  for (const transcript of transcripts) {
    if (!transcript.contactName) continue;
    for (const part of transcript.contactName.toLowerCase().split(/[^a-z؀-ۿ]+/)) {
      if (part.length >= 3) fragments.add(part);
    }
  }
  return [...fragments];
}

/**
 * Refuse the whole inference, or return null if it is clean.
 *
 * The whole thing, not the offending step. A procedure with one step removed
 * still reads as complete, and the reviewer would be judging a method with a
 * hole in it that nothing on the screen mentions.
 */
export function findLeakInSteps(steps: ProcedureStep[], names: string[]): string | null {
  const joined = steps.map((step) => step.text).join("\n");

  const pii = scanForPii(joined);
  if (pii.length > 0) {
    // The kinds, never the values: this string is logged and shown.
    return `contains ${[...new Set(pii.map((match) => match.type))].join(", ")}`;
  }

  const haystack = joined.toLowerCase();
  const named = names.find((fragment) => haystack.includes(fragment));
  if (named) return "names one of the customers it was drawn from";

  return null;
}

export type SkipReason =
  | "not enough conversations"
  | "no model reply"
  | "unparseable model reply"
  | "no shared method"
  | "would leak someone";

export interface IntentOutcome {
  intent: string;
  wellHandled: number;
  /** Present when something was written. */
  write?: InferenceWrite;
  /** Present when nothing was. */
  skipped?: { reason: SkipReason; detail?: string };
}

export interface BusinessInferenceRun {
  organizationId: string;
  businessSlug: string;
  intents: IntentOutcome[];
}

/**
 * One business, one pass.
 *
 * NOTE THE TRANSACTION BOUNDARIES, which are deliberate and not obvious.
 * `withTenant` holds a pooled connection inside an open transaction for as long
 * as its callback runs. Wrapping the whole pass — including a model call per
 * intent — would keep a connection idle-in-transaction for however long the API
 * takes, per business, every night. So the evidence is read in one short
 * transaction, the model is called with no database context held at all, and
 * each write opens its own.
 *
 * The cost of that: a conversation could in principle gain a human reply
 * between the read and the write, so an inference is drawn from evidence that
 * was true a few seconds ago. That is fine here in a way it would not be for a
 * booking — nothing is committed to a customer, the row is inactive, and the
 * next run corrects it.
 */
export async function inferProceduresForBusiness(
  organizationId: string,
  businessSlug: string,
  businessName: string
): Promise<BusinessInferenceRun> {
  const wellHandled = await withTenant(organizationId, () =>
    findWellHandledConversations(organizationId)
  );

  const byIntent = new Map<string, WellHandledConversation[]>();
  for (const row of wellHandled) {
    const list = byIntent.get(row.intent) ?? [];
    list.push(row);
    byIntent.set(row.intent, list);
  }

  const intents: IntentOutcome[] = [];

  for (const [intent, conversations] of byIntent) {
    if (conversations.length < MIN_WELL_HANDLED_CONVERSATIONS) {
      intents.push({
        intent,
        wellHandled: conversations.length,
        skipped: { reason: "not enough conversations" },
      });
      continue;
    }

    const sample = conversations.slice(0, MAX_TRANSCRIPTS).map((row) => row.conversationId);
    const transcripts = await withTenant(organizationId, () => loadTranscripts(sample));

    const reply = await completeText({
      system:
        "You write short internal procedures for a small business's customer-service assistant. " +
        "You are describing how the business already works, not advising it how to work. " +
        "You never repeat anything specific to one customer.",
      prompt: buildPrompt(businessName, intent, transcripts),
      maxTokens: 600,
    });

    if (!reply) {
      intents.push({ intent, wellHandled: conversations.length, skipped: { reason: "no model reply" } });
      continue;
    }

    const payload = extractJson(reply) as { steps?: unknown } | null;
    if (!payload || !Array.isArray(payload.steps)) {
      intents.push({
        intent,
        wellHandled: conversations.length,
        skipped: { reason: "unparseable model reply" },
      });
      continue;
    }

    // The escape hatch being used is a real answer. Treated as one rather than
    // as an error, so a business whose enquiries genuinely have no common shape
    // is left alone instead of being handed an invented method.
    if (payload.steps.length === 0) {
      intents.push({
        intent,
        wellHandled: conversations.length,
        skipped: { reason: "no shared method" },
      });
      continue;
    }

    const parsed = parseProcedureSteps(payload.steps);
    if (!parsed.ok) {
      intents.push({
        intent,
        wellHandled: conversations.length,
        skipped: { reason: "unparseable model reply", detail: parsed.error },
      });
      continue;
    }

    const leak = findLeakInSteps(parsed.steps, nameFragments(transcripts));
    if (leak) {
      // Logged loudly. A model that starts quoting customers into procedures is
      // not a small quality problem, and the only way anyone finds out is if
      // this line exists.
      logger.warn(
        { business: businessSlug, intent, leak },
        "Discarded an inferred procedure that would have carried a customer's details into every future reply"
      );
      intents.push({
        intent,
        wellHandled: conversations.length,
        skipped: { reason: "would leak someone", detail: leak },
      });
      continue;
    }

    const write = await withTenant(organizationId, () =>
      upsertInferredProcedure({
        organizationId,
        intentCategory: intent,
        language: PROCEDURE_LANGUAGE,
        steps: parsed.steps,
        derivedFromCount: conversations.length,
      })
    );

    intents.push({ intent, wellHandled: conversations.length, write });
  }

  return { organizationId, businessSlug, intents };
}

/**
 * Every business, once.
 *
 * One business failing must not abandon the rest — the same rule the quality
 * rollup keeps, and for the same reason: a thrown error would leave every
 * organization after it in the list silently unprocessed.
 */
export async function inferProceduresForAllBusinesses(): Promise<BusinessInferenceRun[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Said out loud rather than looping over five businesses and producing five
    // identical empty results, which would read as "nothing to learn".
    logger.warn("Procedure inference skipped: no ANTHROPIC_API_KEY is configured");
    return [];
  }

  const organizations = await withAllTenants(
    "F10 procedure inference: iterate every business, then scope to each",
    () => listOrganizations()
  );

  const runs: BusinessInferenceRun[] = [];
  for (const organization of organizations) {
    try {
      const run = await inferProceduresForBusiness(
        organization.id,
        organization.slug,
        organization.name
      );
      runs.push(run);
      logger.info(
        { business: organization.slug, ...summarise(run) },
        "Procedure inference complete"
      );

      // F14's automatic action, immediately after the evidence that feeds it.
      //
      // Same job rather than a second timer: acting on evidence the moment it
      // is written is the point, and two schedules would only create a window
      // where the writer and the switch disagree about what the drafts say.
      //
      // Its own try, because switching a procedure on is a different kind of
      // failure from inferring one. A collision on the one-active-per-situation
      // index must not be reported as "procedure inference failed" — the
      // inference succeeded, and the sentence a person reads should say which
      // half went wrong.
      try {
        const activated = await activateWellEvidencedProcedures(organization.id);
        if (activated.length > 0) {
          logger.info(
            { business: organization.slug, count: activated.length },
            "Procedures switched on automatically — procedure-switched-on will tell the business"
          );
        }
      } catch (err) {
        logger.error(
          { business: organization.slug, err },
          "Automatic procedure activation failed — the drafts stay off, which is the safe direction"
        );
      }
    } catch (err) {
      logger.error({ business: organization.slug, err }, "Procedure inference failed");
    }
  }

  return runs;
}

/**
 * A run in numbers.
 *
 * `written` counts only outcomes that changed something a reviewer would see.
 * An "unchanged" re-statement of yesterday's draft is not a procedure written,
 * and counting it as one would report five nightly successes for a writer that
 * has produced nothing new since Tuesday.
 */
export function summarise(run: BusinessInferenceRun): {
  considered: number;
  written: number;
  proposed: number;
  skipped: number;
} {
  let written = 0;
  let proposed = 0;
  let skipped = 0;
  for (const intent of run.intents) {
    if (intent.skipped) skipped++;
    else if (intent.write?.outcome === "created" || intent.write?.outcome === "redrafted") written++;
    else if (intent.write?.outcome === "proposed") proposed++;
  }
  return { considered: run.intents.length, written, proposed, skipped };
}
