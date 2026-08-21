import type { OperatorFinding } from "@/lib/api";

/**
 * Where somebody goes to act on a finding.
 *
 * ============================================================
 * WHY THIS IS KEYED ON THE OPERATOR
 * ============================================================
 *
 * The obvious design is to map `subjectKind` to a screen, and it does not work
 * here. Ten of the sixteen operators carry `subjectKind: "organization"` —
 * `thin-knowledge`, `template-rejected`, `unowned-followup`,
 * `procedure-awaiting-review` and the rest — and the screen you fix them on is
 * a different one every time. The subject says WHAT the finding is about; only
 * the operator says what you would do about it.
 *
 * So each entry is a decision rather than a derivation, and every operator has
 * to have one — `every-finding-says-where-to-go` fails on a new operator that
 * does not, which is the same shape as the roster this deck already keeps.
 *
 * ============================================================
 * THE FINDING'S OWN WORDS DECIDE
 * ============================================================
 *
 * Where a finding names a screen in its detail text, this points at that
 * screen. `booking-without-anyone` says "Add someone on the Team screen", so it
 * goes to the team page and not to wherever an agent's tools are edited. A
 * notification that says one thing and links to another is worse than one that
 * only says it.
 */

/** Deck routes, from apps/web/app/deck. `inbox` is the one page outside it. */
type Destination =
  | { screen: string; conversation?: false }
  | { screen: "inbox"; conversation: true };

const WHERE: Record<string, Destination> = {
  // A customer is waiting, or was promised somebody who never came. The only
  // useful destination is the conversation itself.
  "customer-waiting": { screen: "inbox", conversation: true },
  "handover-abandoned": { screen: "inbox", conversation: true },

  // Promises made to a customer and not kept.
  "overdue-followup": { screen: "tasks" },
  "unowned-followup": { screen: "tasks" },

  // What the agent answers from.
  "broken-knowledge": { screen: "knowledge" },
  "thin-knowledge": { screen: "knowledge" },
  "retrieval-unavailable": { screen: "knowledge" },

  // How the agent answers.
  "procedure-awaiting-review": { screen: "procedures" },
  "wording-awaiting-review": { screen: "procedures" },

  // Who is available to take work.
  "booking-unassigned": { screen: "team" },
  "booking-without-anyone": { screen: "team" },

  // Outbound machinery.
  "template-rejected": { screen: "broadcasts" },
  "reengagement-candidate": { screen: "broadcasts" },
  "delivery-failing": { screen: "broadcasts" },

  // Platform health. Nothing on these is fixed by editing a row — they are
  // read alongside the quality numbers they distort, which is where somebody
  // looking at them would already be.
  "judge-offline": { screen: "quality" },
  "intent-unclassified": { screen: "quality" },
  "agent-unavailable": { screen: "quality" },

  // The sweep itself has stopped. There is no screen for that: the finding is
  // about the thing producing the findings, and the page it would link to is
  // the one already being read.
  "schedule-stalled": { screen: "operators" },
  // Same answer and the same reason: the subject is a background job, not a
  // row, and there is no screen that shows one. The finding carries the error
  // itself, which is the thing somebody actually needs.
  "job-failing": { screen: "operators" },
};

/**
 * The link for a finding, or null when there is nowhere useful to send anybody.
 *
 * Null rather than a guess. A link to a page that cannot show the thing is a
 * worse outcome than plain text: it costs a click and a scroll to discover
 * there was nothing there.
 */
export function whereToFixIt(finding: OperatorFinding): string | null {
  const destination = WHERE[finding.operator];
  if (!destination) return null;

  const business = encodeURIComponent(finding.businessSlug);

  if (destination.conversation) {
    // Without a subject there is no conversation to open, so this degrades to
    // the business's inbox rather than to a broken link.
    return finding.subjectId
      ? `/inbox?business=${business}&conversation=${encodeURIComponent(finding.subjectId)}`
      : `/inbox?business=${business}`;
  }

  return `/deck/${destination.screen}?business=${business}`;
}

/** Exported for the test that requires every operator to have a destination. */
export const DESTINATIONS = WHERE;
