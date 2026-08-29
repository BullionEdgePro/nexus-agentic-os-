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
 *   3. The agent answers the inquiry, which is what the company number is for,
 *      and in that same first reply hands them a one-tap link to THAT staff
 *      member's own WhatsApp.
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
 * design: the business sees the conversation and answers it, and the handover
 * to the person happens in that same reply. A link straight to a
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
 * ============================================================
 * IMMEDIATE, BUT ONCE
 * ============================================================
 *
 * The owner's instruction is that a customer who came through a staff member's
 * link is handed to that person straight away, every time — not held until they
 * think to ask for a human. So the link goes out in the FIRST reply, alongside
 * a real answer to whatever they asked.
 *
 * `firstReply` is what keeps "immediately" from becoming "in every message".
 * A link repeated in each reply stops reading as help and starts reading as an
 * attempt to get rid of the customer, and it is exactly the kind of thing a
 * model will do forever if the instruction does not say when to stop. It comes
 * from the attribution write, which is guarded on `referred_by_employee_id is
 * null` and therefore true exactly once per conversation — the message that
 * carried the tag, which is the first one.
 *
 * The agent still ANSWERS. The company number exists so an inquiry gets a real
 * reply at any hour; handing over a question without answering it would make
 * every link a slower way of reaching the same person.
 */
export function describeReferringColleague(input: {
  employeeName: string;
  handoffLink: string | null;
  firstReply: boolean;
}): string {
  const firstName = input.employeeName.trim().split(/\s+/)[0] || input.employeeName;

  const lines = [
    "INTERNAL — for you alone. Do not quote or explain this block.",
    "",
    `This customer arrived through ${input.employeeName}'s own link, so ${firstName} is`,
    "the colleague this conversation belongs to.",
  ];

  if (!input.handoffLink) {
    lines.push(
      "",
      `${firstName} has no direct number on file, so there is nothing to hand the customer.`,
      "Do NOT invent a number, and do not say you will pass a message to them personally —",
      "no notification is sent by mentioning their name. Answer the customer yourself, and if",
      "they need a person, use the business's own contact details from your instructions."
    );
    return lines.join("\n");
  }

  if (input.firstReply) {
    lines.push(
      "",
      "ANSWER THEIR QUESTION FIRST, properly and in full — they asked it and they deserve a",
      "reply. Then, in the same message, hand them to " + firstName + ": say that " + firstName,
      "looks after this personally and that this link opens a chat with them directly.",
      "",
      input.handoffLink,
      "",
      "Put the link on its own line, exactly as written, with nothing added and nothing",
      "removed — no brackets, no full stop after it, no shortening. Do not describe it as a",
      "transfer, a bot, an automated system or a ticket. One or two short sentences around",
      "it; a paragraph of explanation makes a simple handover sound like a problem."
    );
  } else {
    lines.push(
      "",
      `${firstName}'s direct link has ALREADY been sent to this customer earlier in this`,
      "conversation. Do not send it again unless they ask for it or ask to speak to somebody:",
      "a link repeated in every reply reads as trying to end the conversation rather than help",
      "it. Keep answering them yourself.",
      "",
      "If they do ask, the link is:",
      input.handoffLink
    );
  }

  return lines.join("\n");
}
