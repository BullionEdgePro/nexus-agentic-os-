/**
 * The link that remembers whose it was.
 *
 * ============================================================
 * THE PROBLEM THIS SOLVES, AND WHY IT NEEDED NO API
 * ============================================================
 *
 * A staff member's personal WhatsApp cannot be connected to this platform. The
 * consumer app has no API, and the tools that pretend otherwise get the
 * business banned. That is a hard wall and it does not move.
 *
 * But the thing actually wanted was never "read their phone". It was: a
 * customer who found this person on Instagram should end up talking to THAT
 * person, and the business should still see the conversation. Both halves are
 * achievable without touching anybody's phone:
 *
 *   1. The staff member publishes a link to the COMPANY number carrying a tag
 *      that names them. The customer taps it; WhatsApp prefills the message.
 *   2. The message arrives here. The tag says whose link it was, so the lead is
 *      theirs from the first word — assigned, and in their client book.
 *   3. The agent answers the inquiry, which is what the company number is for.
 *   4. When a human is wanted, the customer is handed a one-tap link to THAT
 *      staff member's own WhatsApp.
 *
 * Step 4 is the part that looked impossible and is not: a link the CUSTOMER
 * taps needs no API at all. The conversation moves to the staff member's real
 * phone, where they were always going to answer it, and the business keeps the
 * record of how it started.
 *
 * ============================================================
 * WHY A SECOND TAG RATHER THAN A CLEVERER FIRST ONE
 * ============================================================
 *
 * The business tag `#zipicka` is anchored to the START of the message and is
 * read by the router before anything else. Encoding the staff member into it —
 * `#zipicka-aqib` — would have been fewer characters and would have broken
 * business routing for every existing published link the moment a slug and a
 * code collided. The tags are separate because they answer different questions
 * and are allowed to be absent independently: a business link with no staff tag
 * is the ordinary case, and a staff tag whose owner has left is a lead for the
 * business rather than a lead for nobody.
 */

/**
 * A staff tag anywhere in the message, not only at the start.
 *
 * The business tag is start-anchored on purpose, so a customer quoting somebody
 * else's message cannot silently reroute a conversation. That reasoning does
 * not carry here: the prefilled text puts the business tag first, which means
 * the staff tag is by construction NOT first, and anchoring it would match
 * nothing. A word boundary in front is enough to stop `#via-x` matching inside
 * a longer word.
 */
const STAFF_TAG = /(?:^|\s)#via-([a-z0-9][a-z0-9-]{0,40})/i;

/**
 * Which staff member's link this customer came through, if any.
 *
 * Returns the CODE, not an employee: this package does not read the database,
 * and resolving a code to a person is a tenant-scoped lookup that belongs where
 * the tenant is known. A code with no matching employee resolves to nobody
 * later, which is the correct outcome for a link belonging to somebody who has
 * left.
 */
export function findStaffTag(text: string): string | null {
  const match = STAFF_TAG.exec(text ?? "");
  return match ? match[1].toLowerCase() : null;
}

/**
 * The link one staff member publishes on their own socials.
 *
 * Points at the COMPANY number, never at their personal one. That is the whole
 * design: the business sees the conversation, the agent answers it, and the
 * handover to the person happens later and deliberately. A link straight to a
 * personal number would give the staff member their lead and give the business
 * nothing — no record, no answer out of hours, and nothing to hand to the next
 * person when they leave.
 *
 * The prefilled text is written to be sent as it stands. A customer may edit it
 * — that is their message, not ours — and if they delete the tag the lead is
 * simply unattributed, which is honest rather than guessed.
 */
export function buildStaffDeepLink(input: {
  businessSlug: string;
  businessName: string;
  employeeCode: string;
  employeeName: string;
  companyNumber: string;
}): string {
  const digits = input.companyNumber.replace(/\D/g, "");
  const firstName = input.employeeName.trim().split(/\s+/)[0] || input.employeeName;
  const text =
    `#${input.businessSlug} #via-${input.employeeCode} ` +
    `Hello ${input.businessName}, I found you through ${firstName} and would like to ask about`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * The one-tap handover to a staff member's own WhatsApp.
 *
 * Built from the DIALABLE number a colleague would ring — never from a
 * phone_number_id, which is Meta's internal identifier and produces a link that
 * looks right, gets sent to a customer, and opens WhatsApp on nothing.
 *
 * Returns null rather than a broken link when there is no usable number. A
 * handover that cannot be completed must be absent, not offered: "here is my
 * colleague's direct line" followed by a dead link is worse than never
 * mentioning it.
 */
export function personalHandoffLink(input: {
  employeeName: string;
  whatsappNumber: string | null;
  businessName: string;
}): string | null {
  const digits = (input.whatsappNumber ?? "").replace(/\D/g, "");
  // Shorter than any international number; longer than any of them too. Both
  // ends checked because a truncated number dials somebody real.
  if (digits.length < 8 || digits.length > 15) return null;
  const firstName = input.employeeName.trim().split(/\s+/)[0] || input.employeeName;
  const text = `Hello ${firstName}, I was speaking to ${input.businessName} on WhatsApp`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * What the agent is told when a customer arrived through somebody's link.
 *
 * ============================================================
 * WRITTEN AS AN INTERNAL BLOCK, FOR A REASON THIS FILE'S NEIGHBOUR LEARNED
 * ============================================================
 *
 * `describeNobodyToEscalateTo` carries a long comment about the day an internal
 * staffing fact was relayed verbatim to a client with a rent dispute, because
 * the instruction stated a fact without saying it was internal. The model
 * followed it exactly and the customer read it.
 *
 * So this says what may be said and what may not, and it does NOT hand the
 * customer a colleague's mobile number unprompted. A person who asked a
 * question about a product has not asked to be passed to somebody's personal
 * phone, and pushing a number at them reads as a brush-off. The link is offered
 * when they want a human — which is exactly when it helps.
 */
export function describeReferringColleague(input: {
  employeeName: string;
  handoffLink: string | null;
}): string {
  const firstName = input.employeeName.trim().split(/\s+/)[0] || input.employeeName;

  const lines = [
    "INTERNAL — for you alone. Do not quote or explain this block.",
    "",
    `This customer arrived through ${input.employeeName}'s own link, so ${firstName} is`,
    "the colleague this conversation belongs to. Answer the question yourself as usual:",
    "arriving through somebody's link is not a request to be passed to them.",
  ];

  if (input.handoffLink) {
    lines.push(
      "",
      `If they ask to speak to a person, ask for ${firstName} by name, or the matter clearly`,
      `needs a human, give them this link and say it opens a chat with ${firstName} directly:`,
      input.handoffLink,
      "",
      "Give the link as it is written, on its own line, with nothing added to it and no",
      "characters removed. Do not describe it as an automated system, a bot or a",
      "transfer. Offer it once — repeating it reads as trying to end the conversation."
    );
  } else {
    lines.push(
      "",
      `${firstName} has no direct number on file, so there is nothing to hand the customer.`,
      "Do NOT invent a number, and do not say you will pass a message to them personally —",
      "no notification is sent by mentioning their name. Help the customer yourself, and if",
      "they need a person, use the business's own contact details from your instructions."
    );
  }

  return lines.join("\n");
}
