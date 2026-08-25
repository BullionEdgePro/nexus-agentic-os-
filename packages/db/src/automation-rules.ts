/**
 * What an automation may react to, and what it may do about it.
 *
 * ============================================================
 * THE SHAPE, AND WHY IT IS THIS SHAPE
 * ============================================================
 *
 * An automation does not watch anything. The operators watch, they have watched
 * since F8, and `overdue-followup` and `unowned-followup` already decide every
 * ten minutes what "overdue" and "unowned" mean for these exact rows. A second
 * evaluator beside them would be two pieces of code answering one question, and
 * the day they disagree one of them is wrong on a screen nobody is comparing.
 *
 * So an automation is a pair: a finding that is already true, and one thing to
 * do about it. This module holds which pairs are allowed. It is pure so the
 * suite can prove the refusals, and the refusals are the interesting half.
 *
 * ============================================================
 * THE LINE THIS DOES NOT CROSS
 * ============================================================
 *
 * Nothing here speaks to a customer.
 *
 * Both actions are things a colleague does: give somebody the work, or write the
 * work down. Sending a message is a thing the BUSINESS does, and this platform
 * spends a great deal of care on that boundary elsewhere — the agent withholds
 * a callback promise when nobody is on the rota, the alert payload carries no
 * customer names, and the reply path stands down entirely when a person has the
 * conversation. An automation that could message a customer would be a wider
 * grant than the reply path itself has, handed out on a checkbox.
 */

/** Every action an automation may take. Two, and the list is the boundary. */
export const AUTOMATION_ACTIONS = ["assign_followup", "create_followup"] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

/**
 * Which operator findings each action can act on, and what it needs from them.
 *
 * An allow-list of pairs rather than "any action on any trigger", because most
 * of the 21 combinations are nonsense and one or two are dangerous. Pairing
 * `assign_followup` with `customer-waiting` would try to assign a conversation
 * as though it were a task; pairing anything with `procedure-switched-on` would
 * have the platform reacting to its own automatic act, which is how a loop
 * starts.
 */
export const AUTOMATION_TRIGGERS: Record<
  AutomationAction,
  { operators: readonly string[]; subjectKind: string; needsAssignee: boolean; describes: string }
> = {
  assign_followup: {
    // The finding's subject IS the task, so this is the only operator whose
    // findings carry something this action can act on.
    operators: ["unowned-followup"],
    subjectKind: "task",
    needsAssignee: true,
    describes: "give a follow-up nobody owns to a named person",
  },
  create_followup: {
    // The subject is a conversation, and the action writes a follow-up against
    // it. Both of these are "somebody is waiting and nothing is written down".
    operators: ["customer-waiting", "handover-abandoned"],
    subjectKind: "conversation",
    needsAssignee: false,
    describes: "write down a follow-up so a waiting customer reaches somebody's board",
  },
};

export interface AutomationSpec {
  action: string;
  triggerOperator: string;
  assigneeId?: string | null;
}

export interface AutomationRefusal {
  reason: string;
}

/**
 * Why this automation may not be created, or null when it may.
 *
 * Returns the sentence a person reads, not a code. Somebody choosing a trigger
 * from a menu and being told "invalid" learns nothing; being told that
 * assigning needs a person, or that this operator's findings are not about
 * follow-ups, learns what to pick instead.
 */
export function automationRefusal(spec: AutomationSpec): AutomationRefusal | null {
  const action = AUTOMATION_ACTIONS.find((a) => a === spec.action);
  if (!action) {
    return {
      reason: `"${spec.action}" is not something an automation can do. It can assign a follow-up, or write one.`,
    };
  }

  const rule = AUTOMATION_TRIGGERS[action];

  if (!rule.operators.includes(spec.triggerOperator)) {
    return {
      reason:
        `"${spec.triggerOperator.replace(/-/g, " ")}" does not report anything this action can act on. ` +
        `${action === "assign_followup" ? "Assigning" : "Writing"} a follow-up works from: ` +
        `${rule.operators.map((o) => o.replace(/-/g, " ")).join(", ")}.`,
    };
  }

  if (rule.needsAssignee && !spec.assigneeId) {
    return { reason: "Choose who the follow-up should go to. An automation cannot assign work to nobody." };
  }

  return null;
}

/**
 * Should this automation act on this finding?
 *
 * The finding is already true — the sweep decided that. What is left is whether
 * this automation is the one for it, and whether the finding carries the thing
 * the action needs to touch.
 */
export function automationActsOn(
  spec: AutomationSpec & { isActive: boolean },
  finding: { operator: string; subjectKind: string | null; subjectId: string | null }
): boolean {
  if (!spec.isActive) return false;
  if (finding.operator !== spec.triggerOperator) return false;

  const action = AUTOMATION_ACTIONS.find((a) => a === spec.action);
  if (!action) return false;

  const rule = AUTOMATION_TRIGGERS[action];
  if (!rule.operators.includes(spec.triggerOperator)) return false;

  // A finding with no subject is one this cannot act on: the action needs
  // something to touch, and "the whole business" is not a follow-up.
  if (finding.subjectKind !== rule.subjectKind) return false;
  return Boolean(finding.subjectId);
}
