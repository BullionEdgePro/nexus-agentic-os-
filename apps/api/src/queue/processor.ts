import type { Job } from "bullmq";
import type {
  ConversationMetricInput,
  InboundWebhookJob,
  MessageDto,
  Organization,
  WhatsAppTextMessage,
  WhatsAppWebhookEntry,
} from "@nexus/shared";
import type { Employee } from "@nexus/shared";
import {
  findOrganizationByPhoneNumberId,
  findOrganizationById,
  findEmployeeForConversation,
  findSharedNumberBusinesses,
  getConversationRouting,
  setConversationRouting,
  recordTriagePrompt,
  recordInboundMessage,
  insertOutboundMessage,
  insertEvaluation,
  recordConversationMetric,
  setConversationHandoff,
  hasActiveEmployees,
  listOpenTasksForContact,
  withTenant,
  withServingTenant,
} from "@nexus/db";
import type { SharedNumberBusiness } from "@nexus/db";
import {
  routeToEmployeeTwin,
  loadRecentHistory,
  classifyBusiness,
  buildTriageMessage,
  resolveTriageReply,
  recallContact,
  rememberContact,
  describeOpenFollowUps,
  upcomingBookingsNote,
  classifyIntent,
} from "@nexus/agents";
import { resolvePresence, containsDigitalSignature } from "@nexus/employees";
import { scoreLead, recordLeadAssessment, countPriorInbound } from "@nexus/leads";
import { evaluateOutgoingMessage, shouldEscalateReply } from "@nexus/governance";
import { sendWhatsAppText } from "../lib/whatsapp-client.js";
import { publishInboxEvent } from "../lib/pubsub.js";
import { hasStaffOnShift } from "../services/availability.js";
import { logger } from "../lib/logger.js";

const FALLBACK_REPLY =
  "Thanks for your message — I want to make sure you get an accurate answer, so I'm looping in a specialist from our team. They'll follow up shortly.";

/**
 * The same moment, when there is nobody to loop in.
 *
 * ESCALATION USED TO PROMISE A PERSON WHO MIGHT NOT EXIST. The reply above says
 * a specialist will follow up, and the code then sets `is_human_handoff`, which
 * PAUSES the agent. Both are correct when somebody is on the rota. With an
 * empty rota they combine into the worst outcome the platform can produce: the
 * customer is told help is coming and simultaneously cut off from the only
 * thing that was answering them. Nothing errors, no counter moves, and the
 * conversation looks exactly like a healthy one.
 *
 * A conversation sat in that state from 2026-08-01 until an operator noticed
 * eleven days later — noticed, necessarily, by watching for the ABSENCE of an
 * event, because there was no event to catch.
 *
 * So this text promises nobody, and the caller leaves the agent running. A
 * further imperfect answer is worse than a good one and enormously better than
 * silence, which is the real alternative.
 */
const FALLBACK_REPLY_NO_STAFF =
  "Thanks for your message — I want to make sure I get this right. Could you tell me a little more about what you need, so I can point you to the right answer?";

// How many times a customer may be handed the triage menu before a human takes
// over. Bounded because the failure mode is a loop: if someone's messages never
// classify and never answer the menu, re-asking forever is worse than silence.
const MAX_TRIAGE_ATTEMPTS = 3;

// Intent classification moved to `classifyIntent` (@nexus/agents/intent.ts).
//
// It used to live here as a tool-only lookup returning null when no tool fired,
// which was 83% of production traffic — so F5's pooled store had almost no
// source to read and could never have filled, however many businesses signed
// up. The replacement also reads the message text, via the bilingual rules lead
// scoring already runs, and returns `unknown` rather than null when it cannot
// place a message. Null now means the classifier did not run at all.

// Time from the customer's message to our reply, in ms. Guards against clock
// skew / malformed timestamps and caps at 24h so a stray value can't overflow
// the metrics int column or pollute the analytics.
/**
 * Recalled memory, fenced as an internal note rather than as prose the agent
 * produced.
 *
 * A conversation turn can only be "user" or "assistant", and this goes in as
 * "assistant" — which tells the model it said this to the customer. The
 * predictable result is "as I mentioned, your attestation…" about a
 * conversation that never happened. Role is stronger evidence to a model than
 * any instruction buried further down, so the text announces what it is before
 * the model reads a word of the content.
 *
 * `describeOpenFollowUps` fences its own text the same way and for the same
 * reason; the two are kept separate because they carry different cautions.
 */
function recallNote(recalled: string): string {
  return (
    "[INTERNAL NOTE — staff context only. This was NOT said to the customer. " +
    "Do not quote it, refer to it, or imply you have spoken before.]\n" +
    recalled
  );
}

function firstResponseMsFrom(inboundTimestamp: string): number | null {
  const inboundMs = Number(inboundTimestamp) * 1000;
  if (!Number.isFinite(inboundMs) || inboundMs <= 0) return null;
  const elapsed = Date.now() - inboundMs;
  if (elapsed < 0 || elapsed > 86_400_000) return null;
  return Math.round(elapsed);
}

// Analytics must never take down the reply pipeline: record metrics
// best-effort and swallow any failure with a log.
async function recordMetricBestEffort(input: ConversationMetricInput): Promise<void> {
  try {
    await recordConversationMetric(input);
  } catch (err) {
    logger.error(
      { conversationId: input.conversationId, err },
      "Failed to record conversation metric (non-fatal analytics write)"
    );
  }
}

export async function processInboundWebhookJob(job: Job<InboundWebhookJob>): Promise<void> {
  const { payload, phoneNumberId } = job.data;

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const messages = change.value.messages ?? [];
      for (const message of messages) {
        if (message.type !== "text" || !message.text) continue;
        // Isolated per message: one bad message in a multi-message webhook
        // payload must not force BullMQ to retry the whole batch, re-doing
        // work for siblings that already succeeded.
        await processSingleTextMessage(phoneNumberId, message, change);
      }
    }
  }
}

async function processSingleTextMessage(
  phoneNumberId: string,
  message: WhatsAppTextMessage,
  change: WhatsAppWebhookEntry["changes"][number]
): Promise<void> {
  const text = message.text;
  if (!text) return; // caller already filters for this, but keep the function safe standalone

  const contactName = change.value.contacts?.find((c) => c.wa_id === message.from)?.profile.name;

  // Resolved outside any tenant context, and correctly so: `organizations` is
  // the tenant registry, not tenant data. Scoping this lookup would be circular
  // — it is the query that decides which tenant we are.
  const organization = await findOrganizationByPhoneNumberId(phoneNumberId);
  if (!organization) {
    logger.warn({ phoneNumberId }, "No organization mapped to inbound phone_number_id");
    return;
  }

  // Filled in inside the tenant block, acted on after it closes.
  //
  // A holder rather than a bare `let`: TypeScript's control-flow analysis
  // assumes a callback may never run, so a plain variable stays narrowed to
  // `null` and the check at the end becomes unreachable. The object keeps the
  // union intact without a cast that would hide a real mistake later.
  const deferred: {
    memory: { organizationId: string; contactId: string; conversationId: string } | null;
  } = { memory: null };

  // From here the tenant is known, so everything below runs scoped to it rather
  // than platform-wide. Wrapping the whole job cross-tenant would have been
  // simpler and would have defeated the point: the message pipeline is the
  // largest body of tenant-scoped code in the system, and it is exactly where a
  // forgotten WHERE clause would leak one business's customer into another's.
  await withTenant(organization.id, async () => {

  // Deliberately NOT inside the try/catch below: a failure here means an
  // infrastructure problem (DB down), not an AI/agent problem. Let it
  // propagate so BullMQ retries the whole job — safe to redo thanks to the
  // wa_message_id unique constraint (recordInboundMessage is a no-op on
  // replay once the message is already stored).
  const inboundResult = await recordInboundMessage({
    organizationId: organization.id,
    contactWaId: message.from,
    contactName,
    waMessageId: message.id,
    body: text.body,
    rawPayload: message,
  });
  // `isHumanHandoff` is reassigned below when the flag turns out to be stale.
  const { conversationId, contactId, messageId, aiPausedUntil } = inboundResult;
  let { isHumanHandoff } = inboundResult;

  if (!messageId) {
    // Meta redelivered a message we already processed — skip the agent call.
    return;
  }

  const inboundDto: MessageDto = {
    id: messageId,
    conversationId,
    direction: "inbound",
    senderType: "contact",
    body: text.body,
    status: "delivered",
    createdAt: new Date().toISOString(),
  };
  await publishInboxEvent({
    type: "message",
    organizationId: organization.id,
    organizationSlug: organization.slug,
    conversationId,
    message: inboundDto,
  });

  // Lead scoring. Best-effort and fire-and-forget for the same reason analytics
  // is: a scoring failure must never be able to stop a customer getting a
  // reply. Runs for every inbound message including ones the AI will not
  // answer, because a message arriving during human handoff is exactly the kind
  // a human needs prioritized.
  await scoreLeadBestEffort({
    organizationId: organization.id,
    contactId,
    conversationId,
    messageId,
    text: text.body,
  });

  const aiPaused = Boolean(aiPausedUntil && new Date(aiPausedUntil).getTime() > Date.now());

  // A HANDOFF FLAG IS A PERMANENT MUTE, AND NOTHING EVER CLEARS IT.
  //
  // `aiPaused` expires on its own — a person deliberately taking a conversation
  // for a while. `is_human_handoff` does not: it is set when the agent escalates
  // and cleared only when a human works the conversation. With an empty rota
  // nobody ever does, so the flag is a switch that only turns off.
  //
  // Four Zipicka conversations were found in exactly that state, muted since
  // 2026-08-01. Two were cold pitches and no loss. Two were people who said
  // "Hi", were told a specialist would follow up, and would have been met with
  // silence for the rest of the account's life.
  //
  // Not setting the flag any more (see FALLBACK_REPLY_NO_STAFF) stops new ones
  // and does nothing for those. Clearing them by hand would fix four rows and
  // not the rule, and the rule bites again the moment a business's only
  // employee is deactivated.
  //
  // So the flag is read as what it means — "a person is handling this" — and
  // checked against whether a person could be. If not, it is stale: the agent
  // answers, and the flag is cleared so the state stops claiming a human is
  // involved. A conversation genuinely being handled is untouched, because that
  // business has staff.
  if (isHumanHandoff && !aiPaused) {
    // ROTA, NOT SHIFT — deliberately different from the escalation sites below.
    //
    // The question here is "could this handoff ever be picked up", not "is
    // somebody at their desk this minute". Using presence would release a
    // paused conversation every night at 3am and hand it back to the agent,
    // even though the person it was given to will read it in the morning.
    const someoneCanHandle = await hasActiveEmployees(organization.id).catch(() => true);
    if (!someoneCanHandle) {
      logger.warn(
        { conversationId, organizationId: organization.id },
        "Releasing a handoff nobody can take — the business has no active staff"
      );
      // Best-effort: failing to clear the flag must not stop the reply. The
      // worst case is that this runs again on the next message, which is
      // exactly what it is for.
      await setConversationHandoff(conversationId, false).catch((err) => {
        logger.error({ err, conversationId }, "Could not clear a stale handoff flag");
      });
      isHumanHandoff = false;
    }
  }

  if (isHumanHandoff || aiPaused) {
    logger.debug(
      { conversationId, isHumanHandoff, aiPaused },
      "Skipping AI agent — conversation is in human handoff"
    );
    return;
  }

  // Switchboard. On a dedicated number this resolves to the owning tenant
  // immediately and costs one indexed query; on a shared number it decides
  // which business the enquiry is for, or asks.
  //
  // Deliberately placed before the agent is loaded and before governance is
  // evaluated, because the routed tenant selects BOTH — answering first and
  // attributing afterwards would mean the number owner's policy had already
  // approved the reply.
  const decision = await resolveServingOrganization({
    phoneNumberId,
    conversationId,
    contactId,
    contactWaId: message.from,
    owner: organization,
    text: text.body,
  });
  if (decision.kind === "asked") return; // triage question sent; wait for the answer
  const serving = decision.organization;

  // Employee Agent Layer. Resolved best-effort on purpose: a tenant that has
  // not onboarded employees resolves to null and takes exactly the original
  // org-level path, and a failure looking employees up must degrade to that
  // same path rather than break a reply flow that worked before this layer
  // existed.
  const employee = await resolveAssignedEmployee(conversationId);
  const presence = employee ? resolvePresence(employee) : null;

  if (employee && presence && !presence.shouldTwinRespond) {
    // The human owns this conversation right now (they are online and opted
    // into human_first, or their twin is switched off). This is a deliberate,
    // recorded handoff rather than silence — the deck shows it as human-owned.
    logger.debug(
      { conversationId, employeeId: employee.id, presence: presence.status },
      "Employee is handling this conversation — twin standing down"
    );
    await flagHandoffBestEffort(organization, conversationId);
    return;
  }

  const agent = await routeToEmployeeTwin(serving, employee);
  if (!agent) {
    logger.warn({ organizationId: serving.id }, "No active agent configured for organization");
    return;
  }

  // Everything below is "generate and deliver an AI reply" — a failure
  // anywhere in this sequence (Anthropic API down/rate-limited/bad key,
  // WhatsApp send failure, a DB write failing right after a successful
  // send) must never leave the customer with silence, and must never
  // re-throw in a way that makes BullMQ retry this block — a retry would
  // re-run a non-deterministic LLM call and could send a second, different
  // reply to the same inbound message.
  let sentToCustomer = false;
  try {
    const history = await loadRecentHistory(conversationId);

    // Recall is scoped to the SERVING business, not the number owner — the same
    // person can talk to a shop and a law firm on this one number, and each
    // must remember them separately. contactId already encodes that (contacts
    // are unique per organization), so this is belt and braces on a mistake
    // that would be invisible if made.
    //
    // `withServingTenant` on all three enrichments below, for the reason spelled
    // out on hasStaffOnShift: this transaction is scoped to the number's owner,
    // and every one of these asks about the serving business. Read as the owner,
    // RLS returned nothing and each enrichment degraded to "there is nothing to
    // add" — which is exactly what an empty result legitimately means, so
    // nothing anywhere could tell the two apart.
    const recalled = await withServingTenant(serving.id, () =>
      recallContact(serving.id, contactId)
    ).catch(() => null);

    // What this business still owes this customer.
    //
    // Recorded when the promise was made, read on a page someone opens later —
    // and neither of those is the moment it matters. That moment is this one:
    // the customer writing back. Without this, "did you call me?" reaches an
    // agent with no idea a callback was ever owed, and the fluent answer is a
    // wrong one.
    //
    // Failure is soft and silent for the same reason every other enrichment
    // here is: a customer waiting on a reply must not wait on a follow-up
    // lookup. An empty list is indistinguishable from a failed one to
    // everything downstream, which is correct — both mean "nothing to add".
    const owed = await withServingTenant(serving.id, () =>
      listOpenTasksForContact(serving.id, contactId)
    ).catch(() => []);
    const owedNote = describeOpenFollowUps(
      owed.map((task) => ({
        title: task.title,
        dueAt: task.dueAt,
        isOverdue: task.isOverdue,
        owner: task.employeeName,
      })),
      serving.timezone ?? "Asia/Dubai"
    );
    // What this customer already has in the diary.
    //
    // The moment an appointment matters most is when the person who made it
    // writes back — "what time am I coming in?", "can we move it?". Without
    // this the agent answers that fluently and wrongly, and worse, happily
    // books a second appointment on top of the first. The exclusion constraint
    // would not stop it: two bookings for the same customer with two different
    // employees are not a double-booking as far as the database is concerned.
    const bookedNote = await withServingTenant(serving.id, () =>
      upcomingBookingsNote(serving.id, contactId, serving.timezone ?? "Asia/Dubai")
    ).catch(() => null);

    // Each note is prepended fenced separately rather than merged. They are
    // different kinds of fact carrying different instructions — memory is what
    // we know about this person, follow-ups are what we owe them and must not
    // claim to have done, appointments are what is already agreed — and running
    // them together would blur which caution applies to which.
    const notes = [recalled ? recallNote(recalled) : null, owedNote, bookedNote].filter(
      (note): note is string => note !== null
    );

    const withRecall = notes.length
      ? [...notes.map((content) => ({ role: "assistant" as const, content })), ...history]
      : history;

    const result = await agent.respond(
      {
        // The routed tenant, not the number owner: this scopes knowledge
        // retrieval, so passing the owner here would let a shared number answer
        // a legal question out of the retail knowledge base.
        organizationId: serving.id,
        contactWaId: message.from,
        contactName,
        messageId: message.id,
        text: text.body,
        timestamp: message.timestamp,
        // Carried so book_appointment can write a row naming an actual person.
        // A booking tool that had to resolve the customer itself would have to
        // guess from the wa_id, and on a shared number the same number is a
        // different contact for a different business. Passing what this job
        // already resolved is the only version with no guess in it.
        contactId,
        conversationId,
      },
      withRecall
    );

    if (!result.text) return;

    // THE JUDGE WAS BEING ASKED TO AUDIT GROUNDED ANSWERS WITH THE GROUNDING
    // REMOVED.
    //
    // This call passed only the draft and the conversation history. Every fact
    // the agent correctly took from the knowledge base therefore looked, to the
    // judge, like an assertion supported by nothing — which biases it toward
    // "high" on exactly the replies that did their job properly. High escalates
    // for every tenant outside the tolerant allowlist.
    //
    // Retrieval happens inside `agent.respond`, so the passages are not in
    // scope here as a variable; they are in the tool calls the agent actually
    // made. Reconstructing the context from those is the honest definition of
    // "what this reply should be grounded in" — it is what the agent read, not
    // what a second search might have found.
    const retrieved = result.toolCalls
      .filter((call) => call.name === "search_knowledge")
      .map((call) => (typeof call.output === "string" ? call.output : JSON.stringify(call.output)))
      .join("\n\n");

    const evaluation = await evaluateOutgoingMessage({
      draftReply: result.text,
      conversationHistory: history.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
      // Empty when the agent answered without searching, which is a real state
      // and correctly reads as "nothing supports this" rather than as missing
      // plumbing.
      ragContext: retrieved || undefined,
      // Who is speaking. Without it, an agent naming its own company scores as
      // a hallucination — see HallucinationCheckInput.businessName.
      businessName: serving.name,
    });

    // Deterministic backstop for the twin's identity rules: the prompt forbids
    // reproducing the employee's digital signature, but a prompt is guidance,
    // not a guarantee. Signing machine-generated text with a person's
    // attestation is a misrepresentation we refuse to send, so it escalates
    // to that human exactly like a governance failure would.
    const signatureLeak = employee ? containsDigitalSignature(result.text, employee) : false;
    if (signatureLeak) {
      logger.error(
        { conversationId, employeeId: employee?.id },
        "Twin reply reproduced the employee's digital signature — blocked and escalated"
      );
    }

    // Governance is the routed tenant's, not the number owner's — this is the
    // whole reason routing happens before the reply is composed. `juris-prime-legal`
    // escalates at medium hallucination risk and `zipicka` does not; using the
    // owner's slug here would silently apply retail thresholds to legal answers.
    const shouldEscalate = shouldEscalateReply(evaluation, serving.slug) || signatureLeak;

    // Escalating to nobody is worse than not escalating.
    //
    // Asked of the SERVING business, not the number owner: on a shared number
    // the law firm may have staff while the retailer does not, and the question
    // is whether anyone can pick up THIS conversation.
    //
    // Failure is treated as "there is somebody" — the conservative reading. A
    // failed lookup wrongly assumed empty would send a customer a weaker reply
    // and skip a handoff that was warranted; wrongly assumed staffed, it
    // behaves exactly as the system did before this change.
    const canHandOver = shouldEscalate
      ? await hasStaffOnShift(serving.id).catch(() => true)
      : false;

    const finalText = shouldEscalate
      ? canHandOver
        ? FALLBACK_REPLY
        : FALLBACK_REPLY_NO_STAFF
      : result.text;

    if (shouldEscalate && !canHandOver) {
      logger.warn(
        { conversationId, business: serving.slug },
        "Escalation wanted but no active staff — keeping the agent live rather than promising a specialist who does not exist"
      );
    }

    await sendWhatsAppText(phoneNumberId, message.from, finalText);
    sentToCustomer = true;

    // Recorded here, run after the transaction closes. See the note below the
    // withTenant block for why it cannot be fired from inside it.
    deferred.memory = { organizationId: serving.id, contactId, conversationId };

    const outboundDto = await insertOutboundMessage({
      organizationId: organization.id,
      conversationId,
      contactId,
      senderType: shouldEscalate ? "system" : "ai_agent",
      senderId: shouldEscalate ? undefined : agent.config.id,
      body: finalText,
      employeeId: employee?.id ?? null,
    });

    await insertEvaluation(organization.id, outboundDto.id, evaluation);

    await publishInboxEvent({
      type: "message",
      organizationId: organization.id,
      organizationSlug: organization.slug,
      conversationId,
      message: outboundDto,
    });

    // Only pause the agent when somebody can take its place. Pausing with an
    // empty rota does not hand the conversation over — it ends it.
    if (shouldEscalate && canHandOver) {
      await setConversationHandoff(conversationId, true);
      await publishInboxEvent({
        type: "handoff_changed",
        organizationId: organization.id,
        organizationSlug: organization.slug,
        conversationId,
        isHumanHandoff: true,
      });
      logger.warn(
        { conversationId, evaluation },
        "AI reply blocked by governance evaluation, escalated to human handoff"
      );
    }

    // Analytics: token spend, who owns the resolution now, the classified
    // intent, and time-to-first-response. Best-effort — see recordMetricBestEffort.
    await recordMetricBestEffort({
      organizationId: organization.id,
      conversationId,
      intent: classifyIntent({ text: message.text?.body, toolCalls: result.toolCalls }).intent,
      resolvedBy: shouldEscalate ? "human_agent" : "ai_agent",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      firstResponseMs: firstResponseMsFrom(message.timestamp),
    });
  } catch (err) {
    logger.error({ conversationId, sentToCustomer, err }, "AI reply pipeline failed");

    if (sentToCustomer) {
      // The customer already received a real reply — the failure was in
      // bookkeeping afterward (DB write, evaluation log). Don't send a
      // second, confusing "looping in a specialist" message on top of a
      // reply that already went through; just make sure a human is aware.
      await flagHandoffBestEffort(organization, conversationId);
    } else {
      await sendFallbackBestEffort(organization, phoneNumberId, message.from, conversationId, contactId);
    }
  }
  });

  // The contact memory is written AFTER the transaction above has committed and
  // its connection has gone back to the pool.
  //
  // It used to be fired inside that block with `void`, which was a real defect
  // rather than a style choice. The tenant context lives in AsyncLocalStorage
  // and propagates into an un-awaited continuation, so when the summariser's
  // Gemini call resolved — seconds later — its write routed to a client that had
  // already been released. Best case node-postgres refuses to use it. Worst
  // case the pool had handed that connection to another business's request, and
  // the write landed inside THAT transaction under THAT tenant's
  // app.current_org: one company's customer memory stored against another's,
  // which is the exact cross-tenant write the whole RLS effort exists to stop.
  //
  // Still not awaited by the caller — a slow summary must not delay the job —
  // but it now opens its own scoped transaction, so nothing it touches belongs
  // to anyone else.
  const pending = deferred.memory;
  if (pending) {
    void withTenant(pending.organizationId, () => rememberContact(pending)).catch(() => undefined);
  }
}

/**
 * Which business this message is for.
 *
 * `asked` means a triage question went out and nothing further should happen
 * for this message — the customer's answer arrives as the next inbound message
 * and is resolved against the menu we just sent.
 */
type ServingDecision =
  | { kind: "serve"; organization: Organization }
  | { kind: "asked" };

/**
 * Decide which tenant answers, on a number that may be shared.
 *
 * The important property is that this degrades to the pre-switchboard
 * behaviour in every failure case. A dedicated number, a lookup failure, a
 * routed tenant that has since been deactivated — all of them resolve to the
 * number's owner and take exactly the path that existed before routing did.
 * A customer never goes silent because triage could not make up its mind.
 *
 * Note the asymmetry in what "safe" means here. Refusing to route costs a
 * question; routing wrongly puts an enquiry in front of an agent operating
 * under a different business's governance policy. That is why an ambiguous
 * message asks rather than picking the most likely candidate.
 */
async function resolveServingOrganization(ctx: {
  phoneNumberId: string;
  conversationId: string;
  contactId: string;
  contactWaId: string;
  owner: Organization;
  text: string;
}): Promise<ServingDecision> {
  let businesses: SharedNumberBusiness[];
  try {
    businesses = await findSharedNumberBusinesses(ctx.phoneNumberId);
  } catch (err) {
    logger.error(
      { conversationId: ctx.conversationId, err },
      "Shared-number lookup failed — serving the number's owner"
    );
    return { kind: "serve", organization: ctx.owner };
  }

  // Fewer than two tenants on this number means there is nothing to triage:
  // the number identifies the business on its own, as it always did.
  if (businesses.length < 2) return { kind: "serve", organization: ctx.owner };

  let state = null;
  try {
    state = await getConversationRouting(ctx.conversationId);
  } catch (err) {
    logger.error({ conversationId: ctx.conversationId, err }, "Routing state read failed");
  }

  // Already triaged. Routing is sticky: re-classifying every message would let
  // one off-topic word move a live conversation, and its governance, mid-thread.
  if (state?.routedOrganizationId) {
    const routed = await findOrganizationById(state.routedOrganizationId).catch(() => null);
    if (routed) return { kind: "serve", organization: routed };
    logger.warn(
      { conversationId: ctx.conversationId, routedOrganizationId: state.routedOrganizationId },
      "Conversation was routed to an organization that is no longer active — re-triaging"
    );
  }

  // A bare "2" is only read as an answer if a menu was genuinely sent. Without
  // this check, a first message of "2" would select the second business —
  // and its governance — from a menu the customer never saw.
  if (state?.triagePromptedAt) {
    const picked = resolveTriageReply(ctx.text, businesses);
    if (picked) return commitRoute(ctx, picked, ["triage reply"]);
  }

  const outcome = classifyBusiness(ctx.text, businesses);
  if (outcome.kind === "routed") return commitRoute(ctx, outcome.business, outcome.matched);

  logger.debug(
    {
      conversationId: ctx.conversationId,
      outcome: outcome.kind,
      candidates: outcome.kind === "ambiguous" ? outcome.candidates.map((b) => b.slug) : [],
    },
    "Cannot determine which business this enquiry is for"
  );

  if ((state?.triageAttempts ?? 0) >= MAX_TRIAGE_ATTEMPTS) {
    logger.warn(
      { conversationId: ctx.conversationId, attempts: state?.triageAttempts },
      "Triage exhausted — handing the conversation to a human"
    );
    await sendFallbackBestEffort(
      ctx.owner,
      ctx.phoneNumberId,
      ctx.contactWaId,
      ctx.conversationId,
      ctx.contactId
    );
    return { kind: "asked" };
  }

  await askWhichBusiness(ctx, businesses);
  return { kind: "asked" };
}

async function commitRoute(
  ctx: { conversationId: string; owner: Organization },
  business: SharedNumberBusiness,
  matched: string[]
): Promise<ServingDecision> {
  const organization = await findOrganizationById(business.id).catch(() => null);
  if (!organization) {
    // Classified to a tenant we then could not load. Serving the owner is
    // wrong-but-answering; the alternative is silence, and the misroute is
    // recorded here rather than hidden.
    logger.error(
      { conversationId: ctx.conversationId, businessSlug: business.slug },
      "Routed to a business that could not be loaded — falling back to the number owner"
    );
    return { kind: "serve", organization: ctx.owner };
  }

  try {
    await setConversationRouting(ctx.conversationId, organization.id);
  } catch (err) {
    // The routing decision stands for this message even if it failed to
    // persist; the next message simply re-classifies.
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to persist routing decision");
  }

  logger.info(
    { conversationId: ctx.conversationId, routedTo: organization.slug, matched },
    "Conversation routed to business"
  );
  return { kind: "serve", organization };
}

/**
 * Send the triage menu and record that we asked.
 *
 * Attributed to the number's owner in the database because the conversation and
 * contact belong to it — this message is sent by the switchboard, before any
 * business is on the hook for it, which is exactly why `buildTriageMessage`
 * makes no claim about price, availability or law.
 *
 * The attempt is recorded only after the send succeeds, so a WhatsApp outage
 * does not burn through the attempt budget and escalate a customer who was
 * never actually asked anything.
 */
async function askWhichBusiness(
  ctx: {
    phoneNumberId: string;
    conversationId: string;
    contactId: string;
    contactWaId: string;
    owner: Organization;
    /** What the customer actually wrote, so the menu answers in their script. */
    text: string;
  },
  businesses: SharedNumberBusiness[]
): Promise<void> {
  const body = buildTriageMessage(businesses, ctx.text);

  try {
    await sendWhatsAppText(ctx.phoneNumberId, ctx.contactWaId, body);
  } catch (err) {
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to send triage question");
    return;
  }

  try {
    await recordTriagePrompt(ctx.conversationId);
  } catch (err) {
    // The customer has the menu but we did not record asking. Their reply will
    // not be read as an ordinal, so they get asked once more — mildly annoying,
    // and strictly better than treating an unprompted number as a selection.
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to record triage prompt");
  }

  try {
    const outboundDto = await insertOutboundMessage({
      organizationId: ctx.owner.id,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      senderType: "system",
      body,
    });
    await publishInboxEvent({
      type: "message",
      organizationId: ctx.owner.id,
      organizationSlug: ctx.owner.slug,
      conversationId: ctx.conversationId,
      message: outboundDto,
    });
  } catch (err) {
    logger.error({ conversationId: ctx.conversationId, err }, "Failed to record triage question");
  }
}

/**
 * Score an inbound message for commercial intent, swallowing any failure.
 *
 * The prior-message count is read before scoring so a returning contact is
 * weighted correctly; if that read fails the message is still scored, just
 * without the returning-contact signal — a slightly worse score beats no score.
 */
async function scoreLeadBestEffort(input: {
  organizationId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  try {
    let priorInboundCount = 0;
    try {
      // Subtract the message just recorded so "prior" really means prior.
      priorInboundCount = Math.max(0, (await countPriorInbound(input.contactId)) - 1);
    } catch (err) {
      logger.debug({ err }, "Prior-message count unavailable; scoring without it");
    }

    const assessment = scoreLead({ text: input.text, priorInboundCount });
    await recordLeadAssessment({
      ...assessment,
      organizationId: input.organizationId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });

    logger.debug(
      { conversationId: input.conversationId, score: assessment.score, priority: assessment.priority },
      "Lead assessed"
    );
  } catch (err) {
    logger.error({ conversationId: input.conversationId, err }, "Lead scoring failed (non-fatal)");
  }
}

/**
 * Look up the employee who owns this conversation.
 *
 * Never throws. An inactive employee is treated as no employee so their
 * conversations fall back to the organization agent rather than going quiet,
 * and a lookup failure does the same — the Employee Agent Layer must be
 * incapable of making the pre-existing reply path worse.
 */
async function resolveAssignedEmployee(conversationId: string): Promise<Employee | null> {
  try {
    const employee = await findEmployeeForConversation(conversationId);
    return employee?.isActive ? employee : null;
  } catch (err) {
    logger.error(
      { conversationId, err },
      "Employee lookup failed — falling back to organization-level agent"
    );
    return null;
  }
}

async function sendFallbackBestEffort(
  organization: Organization,
  phoneNumberId: string,
  contactWaId: string,
  conversationId: string,
  contactId: string
): Promise<void> {
  try {
    // Same question as the governance path, for the same reason: this promises
    // a specialist and then pauses the agent, and with an empty rota that
    // combination abandons the customer while looking healthy. Failure reads as
    // "there is somebody", preserving the previous behaviour rather than
    // silently weakening the reply on a transient error.
    const canHandOver = await hasStaffOnShift(organization.id).catch(() => true);
    const text = canHandOver ? FALLBACK_REPLY : FALLBACK_REPLY_NO_STAFF;

    await sendWhatsAppText(phoneNumberId, contactWaId, text);
    const outboundDto = await insertOutboundMessage({
      organizationId: organization.id,
      conversationId,
      contactId,
      senderType: "system",
      body: text,
    });
    await publishInboxEvent({
      type: "message",
      organizationId: organization.id,
      organizationSlug: organization.slug,
      conversationId,
      message: outboundDto,
    });
    await flagHandoffBestEffort(organization, conversationId);
  } catch (err) {
    // We could not even deliver the fallback — this contact has received
    // NO response at all and needs a human to notice and follow up
    // manually. Nothing further to automate; log loudly.
    logger.error(
      { conversationId, err },
      "Failed to deliver fallback message after AI failure — customer received NO response, needs manual follow-up"
    );
  }
}

/**
 * Pause the agent so a person can take over — but only if a person exists.
 *
 * The guard lives HERE rather than at each of the three call sites, because a
 * check every caller has to remember is a check the fourth caller will not.
 * Setting `is_human_handoff` is not a flag for someone's attention; it stops
 * the agent replying. With an empty rota that does not hand the conversation
 * over, it ends it — silently, in a state that reads as healthy.
 *
 * Left unpaused, the customer keeps getting agent replies. Imperfect, and
 * enormously better than the alternative, which is nothing ever again.
 */
async function flagHandoffBestEffort(organization: Organization, conversationId: string): Promise<void> {
  try {
    // Conservative on failure: assume somebody is there, which preserves the
    // behaviour this function had before the guard existed.
    const canHandOver = await hasStaffOnShift(organization.id).catch(() => true);
    if (!canHandOver) {
      logger.warn(
        { conversationId, business: organization.slug },
        "Not pausing the agent — no active staff, so a handoff would abandon this conversation rather than transfer it"
      );
      return;
    }

    await setConversationHandoff(conversationId, true);
    await publishInboxEvent({
      type: "handoff_changed",
      organizationId: organization.id,
      organizationSlug: organization.slug,
      conversationId,
      isHumanHandoff: true,
    });
  } catch (err) {
    logger.error({ conversationId, err }, "Failed to flag conversation for human handoff after AI failure");
  }
}
