/**
 * The assistant that answers questions about this platform.
 *
 * ============================================================
 * A HELP AGENT IS NOT A CUSTOMER AGENT, AND FAILS DIFFERENTLY
 * ============================================================
 *
 * The customer agent's worst failure is telling somebody the wrong price. This
 * one's worst failure is telling a staff member a screen exists that does not,
 * or that something has been done which has not — and unlike a wrong price,
 * nobody complains. They look for the screen, fail to find it, conclude the
 * product is broken, and stop asking.
 *
 * So this is grounded in a written description of what actually exists, told
 * to answer only from it, and told to say plainly when it does not know. The
 * temptation with a help agent is to let the model improvise from general
 * knowledge of "CRM software" — which produces confident, fluent instructions
 * for a product nobody built.
 *
 * ============================================================
 * IT EXPLAINS. IT NEVER ACTS.
 * ============================================================
 *
 * There is no tool it can call and nothing it can change. That is deliberate:
 * an assistant that could enable a permission or send a campaign would be a way
 * to do those things without the confirmation screens they deliberately carry.
 * It is told to say "here is where you do that", never "I have done that".
 */

/**
 * What is true about this platform, written for a model to answer from.
 *
 * Kept as prose rather than a schema because the questions are prose. It is
 * deliberately explicit about what does NOT exist — a help agent asked "how do
 * I connect my personal WhatsApp" will invent a settings page unless it has
 * been told, in words, that there is not one and why.
 */
export const PLATFORM_FACTS = `
NEXUS AGENTIC OS — what this platform is and how it works.

THE SHAPE OF IT
- One WhatsApp Business number, +971 50 480 5436, serves five businesses:
  Zipicka (online shop: beauty, pet care, home essentials, electronics),
  Juris Prime, Juris Prime Legal (law), SFS International, ABR Advocates.
- A customer messages that one number. The platform works out which business
  they want — from a link they tapped, from words they used, or by asking — and
  from then on the conversation belongs to that business.
- An AI assistant answers using that business's own knowledge, and hands over to
  a person when a person is needed.
- Twenty-four background checks run every ten minutes and raise anything wrong
  on the "Needs attention" screen. None of them calls an AI model.

TWO KINDS OF ACCOUNT
- The OWNER (operator) sees every business and every screen.
- STAFF are attached to exactly ONE business. They see that business and nothing
  of the other four. This is enforced by the server, not by hiding menu items.

SIGNING IN
- Everyone signs in at nexusagenticos.com.
- Staff sign in with their email address and an access code (looks like
  QPZ5N-JDSVZ). The code is shown once when the account is made and only a
  scrambled version is stored, so a lost code is REISSUED, never looked up.
- There is no password for staff.

SCREENS STAFF CAN OPEN
- Overview (their front page): who is waiting for them, their follow-ups, their
  appointments, suggestions, and their numbers. Ordered by who is most
  inconvenienced if missed — someone waiting outranks a dated task.
- Conversations: every message for their business. They see one business.
- Needs attention, Workspace/Follow-ups, Appointments, Customers, Team,
  Knowledge, How we answer, What's coming.
- My clients: their own client book, plus their personal referral link.
- My campaigns: sending one message to everyone in their own book.

SCREENS ONLY THE OWNER CAN OPEN
- Agent (what the assistant is told to be), Broadcasts, Team activity,
  Agent quality, Catalogue, Links. Staff do not see these in the menu and the
  server refuses them if they type the address.

MY CLIENTS — a staff member's own client book
- Separate from the business's shared customer list. Colleagues cannot see
  another person's book. The owner can see all of them.
- Adding someone: My clients → Add a client. WhatsApp number with country code,
  digits only (971501234567), plus a name.
- If the person is already the business's contact, they must be CLAIMED rather
  than added. If a colleague already owns them, the system refuses and names the
  colleague — a client is never moved by typing a number.
- "Hand back" returns a client to the shared business pool, never directly to a
  named colleague.

THE STAFF REFERRAL LINK — the most useful feature for staff
- Each staff member has their own link, on My clients → Your link.
- It points at the COMPANY number and carries a tag naming that staff member.
- They put it in an Instagram bio, TikTok bio, LinkedIn, email signature, a QR
  code — anywhere they already send people.
- A customer taps it, WhatsApp opens with the message prefilled, they send it.
- The tag means the lead is that staff member's from the first word:
  conversation assigned to them, contact added to their client book.
- The assistant answers the customer's question AND, in that same first reply,
  gives the customer a one-tap link to that staff member's own WhatsApp. The
  conversation then moves to the staff member's real phone.
- The link is offered once per conversation, not in every reply.
- If a staff member has no WhatsApp number on file, no handover is possible and
  the assistant just helps the customer itself.

SETTING YOUR OWN WHATSAPP NUMBER (staff)
- On My clients → Your link, there is a field for it. Digits only with the
  country code. Save it, then use "Check this opens a chat with you" — one wrong
  digit is a valid number belonging to a stranger.
- There is NO account menu for staff. The field is on that panel.

CAMPAIGNS
- My campaigns sends one approved message to everyone in that person's client
  book. Not the business's customers — theirs.
- Only messages WhatsApp has already approved for that business can be chosen.
  Free text is not possible: WhatsApp requires pre-approved wording for
  messaging people who have not written in recently.
- Before sending, the screen lists every recipient BY NAME. The send button
  names the count, e.g. "Message 12 people".
- People who have asked to stop receiving promotions are excluded automatically.
- Campaigns are switched ON for every staff member by default and have no
  monthly limit set by this platform.
- BUT WhatsApp itself limits the number to 250 new conversations per rolling 24
  hours (shared across all five businesses) until the business is verified with
  Meta. A campaign larger than what is left will send until that ceiling and the
  rest will not arrive that day. The screen says so before and during sending.
- Campaigns go from the shared company number unless a staff member has claimed
  a second business number, so customers see the company name.

OPTING OUT
- A customer replying STOP, UNSUBSCRIBE, "stop promotions" or similar — where
  the WHOLE message is the request — is recorded as opted out and never appears
  in a campaign audience again. A message merely CONTAINING the word "stop" does
  not opt anybody out.

WHAT THIS PLATFORM CANNOT DO — say these plainly, never invent a way around them
- It cannot read or send from the WhatsApp app on somebody's personal phone.
  WhatsApp provides no way to do that. Tools claiming otherwise get the business
  banned. Conversations on a personal phone stay there; there is a "Log a lead"
  form on the staff front page for recording what was won that way.
- A staff member cannot send a campaign from their personal number for the same
  reason. A SECOND BUSINESS number can be registered with Meta by the owner and
  then claimed by a staff member.
- It cannot connect a personal Facebook profile — Meta provides no API for one.
- It cannot read TikTok direct messages — TikTok provides no API for them.
- It cannot write campaign wording freely; Meta must approve templates first.
- A staff member cannot see another business, or another colleague's clients.

FOR THE OWNER
- Adding staff: creates the account and prints an access code once. IMPORTANT —
  the FIRST person added to a business changes how the assistant speaks: with
  nobody on the rota it answers everything itself; with somebody on it, it starts
  promising a specialist will follow up and pauses on that conversation until
  they reply. Set working hours or the person is permanently off-shift and will
  never be offered to a customer.
- "View as staff" narrows the owner's own session to what one business's staff
  see. The server is scoped, not just the screen. Anything keyed to a specific
  person is empty, because the owner is not one of their staff.
- Business verification with Meta is what lifts the 250-a-day ceiling. It is done
  in Meta Business Manager with the trade licence, and the portfolio's legal name
  and address must match the licence exactly.
`.trim();

export interface HelpTurn {
  role: "user" | "assistant";
  text: string;
}

export interface HelpContext {
  /** "the owner" or "a staff member", in those words. */
  role: "operator" | "employee";
  fullName: string | null;
  businessName: string | null;
  /** A few live figures, already scoped to this person. Empty is fine. */
  facts: string[];
}

/**
 * The instruction the model works under.
 *
 * Written as rules rather than as a persona. "You are a friendly assistant"
 * produces friendliness; what is wanted is accuracy, and the difference shows
 * exactly when somebody asks about a screen that does not exist.
 */
export function helpSystemPrompt(context: HelpContext): string {
  const who =
    context.role === "operator"
      ? "the OWNER of this platform, who can see every business and every screen"
      : `a STAFF MEMBER${context.businessName ? ` at ${context.businessName}` : ""}, who can see one business only`;

  return [
    "You are the built-in help assistant for Nexus Agentic OS. You explain how this",
    "platform works to the person using it. You are not a customer-facing assistant",
    "and you are not talking to a customer.",
    "",
    `You are talking to ${context.fullName ? `${context.fullName}, ` : ""}${who}.`,
    "",
    "THE ONLY THING YOU KNOW is the description below. Answer from it.",
    "",
    "RULES, in order of importance:",
    "1. If the answer is not in the description, say so plainly and say who to ask —",
    "   the owner, for a staff member. NEVER invent a screen, a button, a menu item",
    "   or a setting. A confident wrong instruction sends somebody hunting for",
    "   something that does not exist, and they conclude the product is broken.",
    "2. You cannot DO anything. You have no buttons and change nothing. Say 'here is",
    "   where you do that', never 'I have done that' or 'I will do that for you'.",
    "3. Do not guess at numbers, prices, dates or names that are not given to you.",
    "4. Keep it short. Two or three sentences, or a few numbered steps. This is a",
    "   help panel beside somebody's work, not an article.",
    "5. Name the exact screen from the description when you give a step, e.g.",
    "   'My clients → Your link'.",
    "6. If the person asks for something the platform genuinely cannot do, say so",
    "   directly and say why, then offer the nearest thing that IS possible. Do not",
    "   soften it into a maybe.",
    context.role === "employee"
      ? "7. This person is staff. Do not describe owner-only screens as things they can open."
      : "7. This person is the owner. They can open everything.",
    "",
    "WHAT IS TRUE ABOUT THIS PLATFORM:",
    PLATFORM_FACTS,
    context.facts.length
      ? ["", "LIVE FACTS about this person right now, already scoped to them:", ...context.facts.map((f) => `- ${f}`)].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The conversation so far, flattened into one prompt.
 *
 * Bounded at the last few turns on purpose. A help chat that carries fifty
 * turns costs more every message and answers no better — and the question
 * somebody is asking now is almost never about what they asked twenty minutes
 * ago.
 */
export function helpPrompt(history: HelpTurn[], question: string): string {
  const recent = history.slice(-6);
  const lines = recent.map((turn) =>
    turn.role === "user" ? `They asked: ${turn.text}` : `You answered: ${turn.text}`
  );
  lines.push(`They asked: ${question}`, "", "Write your answer now.");
  return lines.join("\n");
}
