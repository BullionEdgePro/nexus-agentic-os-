import { completeText } from "./anthropic-text.js";
import { listOpenTasksForConversation, type TaskRecord } from "@nexus/db";
import { loadRecentHistory } from "./switchboard.js";

/**
 * What an employee needs to know before they message a customer themselves.
 *
 * The handoff already works: the employee gets a WhatsApp link, the AI is
 * paused, the conversation is flagged. What they do not get is any idea what
 * the agent has already said — so they open WhatsApp cold and either re-ask a
 * question the customer has answered, or contradict a commitment the agent
 * made an hour ago. The second one is the expensive failure: to the customer it
 * is one business changing its story.
 *
 * So the brief leads with what was already promised, not with a synopsis.
 *
 * THIS MUST NEVER BLOCK THE HANDOFF. The employee taking the conversation is
 * the operation that matters; the summary is a convenience on top of it. Every
 * failure here returns null and lets the handoff proceed — a model timeout must
 * not stop someone answering their customer.
 */

/** One outstanding promise, carried verbatim rather than summarised. */
export interface OpenFollowUp {
  title: string;
  dueAt: string | null;
  isOverdue: boolean;
  owner: string | null;
}

export interface HandoverBrief {
  /** Two or three sentences. Null when it could not be produced. */
  summary: string | null;
  /** Why there is no summary, for the UI to show instead of an empty panel. */
  unavailableReason: string | null;
  /** How many turns it was built from, so a thin brief is visibly thin. */
  turnsConsidered: number;
  /**
   * True when the follow-up lookup FAILED, as distinct from finding nothing.
   *
   * `openFollowUps: []` used to mean both. A colleague taking a conversation
   * over reads an empty list as "nothing is owed here" — which is the one
   * thing this brief exists to tell them, and the one thing a failed query
   * cannot honestly say.
   */
  followUpsUnavailable: boolean;
  /**
   * What we still owe this customer, STRUCTURED — never passed through the
   * model.
   *
   * The summary above is prose an LLM wrote from the transcript, and that is
   * the right shape for "what is this conversation about". It is the wrong
   * shape for a commitment: asked to summarise, a model turns "call back
   * Tuesday 4pm, owed by Ivan" into "we said we would get back to them",
   * dropping the date and the owner — the only two parts anyone can act on.
   *
   * They are also often not IN the transcript at all. A follow-up raised from
   * the deck, or promised in a phone call, exists as a record with no textual
   * trace for a summariser to find.
   *
   * So these travel beside the summary, unmodified, and survive every failure
   * path below — including the model being unreachable.
   */
  openFollowUps: OpenFollowUp[];
}

const EMPTY = (
  reason: string,
  turns = 0,
  followUps: OpenFollowUp[] = [],
  followUpsUnavailable = false
): HandoverBrief => ({
  summary: null,
  unavailableReason: reason,
  turnsConsidered: turns,
  openFollowUps: followUps,
  followUpsUnavailable,
});

/**
 * The same commitments, written for the AGENT rather than for a colleague.
 *
 * This is the riskier half of the feature and the framing is the whole of it.
 * The agent needs to know a promise is outstanding so it does not contradict
 * one — a customer asking "did you call me back?" must not be told yes. But
 * handing a model a list of things the business intends to do invites three
 * specific failures, and the text below is shaped against each:
 *
 *   1. Repeating them to the customer as if confirming. "I see we're calling
 *      you Tuesday about the quote" — which is now a promise the agent made,
 *      with a date, that nobody on staff has agreed to.
 *   2. Claiming one is done. The single worst answer available here, because
 *      the customer stops chasing something that never happened.
 *   3. Treating a due date as a commitment it may restate or renegotiate.
 *
 * So the instruction is explicit about all three, and the fence declares what
 * the text is before the model reads any of it — the same reason the memory
 * note is fenced. Role is stronger evidence to a model than an instruction
 * buried further down.
 *
 * Returns null for an empty list rather than an empty heading: an internal note
 * saying "outstanding commitments: none" spends context to tell the model
 * nothing, and invites it to mention that there are none.
 */
export function describeOpenFollowUps(
  followUps: OpenFollowUp[],
  timeZone = "Asia/Dubai"
): string | null {
  if (followUps.length === 0) return null;

  const lines = followUps.map((followUp) => {
    const parts: string[] = [];
    if (followUp.dueAt) {
      const when = new Date(followUp.dueAt);
      const stamp = Number.isNaN(when.getTime())
        ? followUp.dueAt
        : when.toLocaleString("en-GB", {
            timeZone,
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
      // Lateness is the server's verdict, carried through — never recomputed
      // here from a clock this process happens to have.
      parts.push(followUp.isOverdue ? `was due ${stamp} and is OVERDUE` : `due ${stamp}`);
    } else {
      parts.push("no date agreed");
    }
    parts.push(followUp.owner ? `owed by ${followUp.owner}` : "not yet assigned to anyone");
    return `- ${followUp.title} (${parts.join(", ")})`;
  });

  return (
    "[INTERNAL NOTE — staff context only. This was NOT said to the customer. " +
    "Do not quote it, refer to it, or imply you have spoken before.]\n" +
    "Things this business has recorded that it still owes this customer:\n" +
    lines.join("\n") +
    "\n\nThese are internal records, not messages. Do not read them out, do not " +
    "promise any of them will happen, and never say one has been done — if the " +
    "customer is chasing something on this list, it has NOT been completed. If " +
    "they ask about one, say it is noted and someone will come back to them, and " +
    "do not agree to a new time yourself."
  );
}

const toFollowUp = (task: TaskRecord): OpenFollowUp => ({
  title: task.title,
  dueAt: task.dueAt,
  isOverdue: task.isOverdue,
  owner: task.employeeName,
});

export async function buildHandoverBrief(conversationId: string): Promise<HandoverBrief> {
  // Fetched FIRST, and independently of everything below, so an outstanding
  // promise reaches the employee even when there is no transcript to read, no
  // API key configured, or the model is down. The commitments are the part
  // somebody is about to act on; the prose is the convenience.
  //
  // A FAILED LOOKUP IS NOT AN EMPTY ONE, and `.catch(() => [])` made them the
  // same value — which inverted the paragraph above. The commitments are the
  // part somebody is about to act on, so the one failure that must never be
  // silent is this one: a colleague reading an empty list concludes nothing is
  // owed, picks the conversation up, and does not make the call we promised.
  let followUps: OpenFollowUp[] = [];
  let followUpsUnavailable = false;
  try {
    followUps = (await listOpenTasksForConversation(conversationId)).map(toFollowUp);
  } catch {
    followUpsUnavailable = true;
  }

  let history: Awaited<ReturnType<typeof loadRecentHistory>>;
  try {
    history = await loadRecentHistory(conversationId, 30);
  } catch {
    return EMPTY("Could not read the conversation history.", 0, followUps, followUpsUnavailable);
  }

  if (history.length === 0) {
    // Not a failure. A conversation with no messages is a real state, and
    // saying "nothing has been said yet" is more useful than an error.
    return EMPTY("Nothing has been said in this conversation yet.", 0, followUps, followUpsUnavailable);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return EMPTY("Summaries are not configured on this deployment.", history.length, followUps, followUpsUnavailable);
  }

  const transcript = history
    .map((turn) => `${turn.role === "user" ? "Customer" : "Us"}: ${turn.content}`)
    .join("\n");

  try {
    const drafted = await completeText({
      prompt:
        `A colleague is about to continue this WhatsApp conversation from their own phone. ` +
                `Write them two or three sentences covering, in this order: anything we have already ` +
                `promised or committed to, what the customer is actually asking for, and what is still ` +
                `unresolved.\n\n` +
                `Use only what is in the transcript. If something is unclear, say it is unclear rather ` +
                `than filling it in — they are about to act on this, and a confident guess is worse ` +
                `than an admitted gap. Write plainly, no preamble, no bullet points.\n\n` +
                `Transcript:\n${transcript}`,
      maxTokens: 400,
    });
    const summary = (drafted ?? "").trim();
    if (!summary) return EMPTY("The summary came back empty.", history.length, followUps, followUpsUnavailable);

    return {
      summary,
      unavailableReason: null,
      turnsConsidered: history.length,
      openFollowUps: followUps,
      followUpsUnavailable,
    };
  } catch {
    // Deliberately swallowed. The caller is mid-handoff and the employee is
    // waiting; surfacing this as an error would fail the operation that matters
    // for the sake of the one that does not.
    return EMPTY("The summary could not be generated just now.", history.length, followUps, followUpsUnavailable);
  }
}

/**
 * What the agent may promise when there is nobody to hand over to.
 *
 * ============================================================
 * THE PROMISE AND THE PLATFORM DISAGREED
 * ============================================================
 *
 * ABR's system prompt says, of an arrest or a detention: "tell them the firm
 * will be alerted immediately and escalate". The reply path then reaches
 * `flagHandoffBestEffort`, finds nobody on the rota, logs
 *
 *     "Not pausing the agent — no active staff, so a handoff would abandon
 *      this conversation rather than transfer it"
 *
 * and returns. No handoff, no inbox event, and — with no alert destination
 * configured — no notification of any kind. The warning goes to a container log
 * that is erased on the next deploy.
 *
 * So on 2026-08-22 a dry run put "My brother has been arrested in Dubai" to
 * ABR's live agent and got back: "I'm flagging this as urgent so the firm is
 * alerted immediately." Nobody would have been alerted. The customer, whose
 * brother is in police custody, would have stopped looking for help.
 *
 * The governance judge passed it, correctly and uselessly: it checks claims
 * against the RETRIEVED KNOWLEDGE, and "the firm is alerted" is a claim about
 * the platform, which is not in any passage it reads.
 *
 * ============================================================
 * WHY THIS IS A NOTE AND NOT A PROMPT EDIT
 * ============================================================
 *
 * The prompt is the tenant's own words about their own firm and is right about
 * what they want. What changed is a fact the prompt cannot know: whether anyone
 * is on the rota RIGHT NOW. Editing five prompts would encode a Tuesday
 * afternoon into text that outlives it, and would still be wrong every evening.
 *
 * It says what is true rather than only forbidding the false thing. A customer
 * in an emergency needs somewhere to go, and "the office is open Monday to
 * Saturday 09:00-18:00" is already in the prompt — so the instruction is to
 * point at it, not merely to stop promising.
 */
/*
 * NO PARAMETER, AND THAT IS A FINDING RATHER THAN A SHORTCUT. The first version
 * took an office number to pass through. There is nowhere to get one:
 * `Organization` carries an id, a slug, a name, two Meta ids and a timezone,
 * and nothing that a customer could dial. That absence is the same one ABR's
 * `no_one_available` phrase is blocked on — it still contains
 * {{office_number}} because the value does not exist anywhere in this platform.
 *
 * So the note points the agent at what IT already has. Every system prompt
 * carries the firm's own contact details in the tenant's own words (ABR's names
 * the building and the opening hours), which is a better answer than a field
 * this platform would have had to invent.
 */
export function describeNobodyToEscalateTo(): string {
  return [
    "PLATFORM STATE — nobody is on the rota for this business right now.",
    "",
    "You must NOT say the firm, the team or a colleague has been alerted, notified,",
    "flagged or told. No notification will be sent. Saying otherwise leaves somebody",
    "waiting for a call that is not coming, and in an urgent matter that is the",
    "worst thing you can do.",
    "",
    "You may still take their details and say a colleague will follow up. For",
    "anything urgent, give them the direct contact details for this business from",
    "your own instructions — the address, the phone number, the opening hours,",
    "whichever you have — and tell them to use it now rather than wait for a reply",
    "here.",
  ].join("\n");
}
