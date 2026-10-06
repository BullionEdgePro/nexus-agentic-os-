import type { ConversationChannel } from "@nexus/shared";

/**
 * Which messaging channels the platform knows about, and where each one stands.
 *
 * A team inbox is multi-channel, but honesty about what is actually connected
 * matters more than a row of logos. Each channel is either LIVE (it can carry a
 * message right now), NEEDS-SETUP (the code is here, waiting on credentials the
 * owner supplies), or AWAITING-APPROVAL (waiting on a third party — Meta — that
 * no code can hurry). This is the single source of truth the Channels screen and
 * the send path both read, so the badge a person sees and what the server will
 * actually do can never drift apart.
 */
export type ChannelState = "live" | "needs-setup" | "awaiting-approval";

export interface ChannelStatus {
  channel: ConversationChannel;
  /** How it reads in the UI. */
  label: string;
  state: ChannelState;
  /** One line: what is true today. */
  summary: string;
  /** What has to happen for it to go (or come back) live — empty when it is. */
  requirements: string[];
  /** Whether an outbound message can leave on this channel right now. */
  canSend: boolean;
}

/** Twilio powers both SMS and voice; one account, checked once. */
function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

/**
 * The live status of every channel, in the order the inbox shows them.
 *
 * Read from configuration, never hard-coded to "on": an operator who has not
 * added Twilio keys sees SMS as needs-setup, and the day they add them it flips
 * to live with no code change. WhatsApp is live while a line answers for it; once
 * the shared line was switched off it counts the people answering on their own.
 */
export interface WhatsAppStanding {
  retiredSharedNumber: { displayNumber: string | null; retiredAt: string } | null;
  staffWithOwnNumber: number;
  activeStaff: number;
}

/**
 * WhatsApp's row. LIVE while the shared line answers. Once that line was
 * switched off (migration 094) WhatsApp is only as live as the people who have
 * connected their own numbers — so it says how many have, and waits on Meta
 * while nobody can (their Tech Provider onboarding fix).
 */
function whatsappStatus(standing?: WhatsAppStanding): ChannelStatus {
  if (!standing?.retiredSharedNumber) {
    return {
      channel: "whatsapp",
      label: "WhatsApp",
      state: "live",
      summary: "Live. Every conversation the platform runs on today.",
      requirements: [],
      canSend: true,
    };
  }
  const { staffWithOwnNumber: connected, activeStaff: total } = standing;
  const line = standing.retiredSharedNumber.displayNumber ?? "The shared number";
  return {
    channel: "whatsapp",
    label: "WhatsApp",
    state: connected > 0 ? "live" : "awaiting-approval",
    summary:
      `${line} was switched off. Staff now answer on their own WhatsApp Business numbers — ` +
      `${connected} of ${total} connected.`,
    requirements:
      connected >= total
        ? []
        : [
            "Each staff member signs in, opens Connections and connects their own WhatsApp Business number.",
            "Meta's Tech Provider onboarding has to work for that connect to finish — it is a Meta bug, reported and waiting on their fix.",
          ],
    canSend: connected > 0,
  };
}

export function channelStatuses(whatsapp?: WhatsAppStanding): ChannelStatus[] {
  const twilio = twilioConfigured();

  return [
    whatsappStatus(whatsapp),
    {
      channel: "email",
      // LIVE, and it was mislabelled "next build" long after it shipped: client
      // mail syncs in as threaded email conversations and replies go out from the
      // inbox, over Gmail or a business (IMAP/SMTP) mailbox. What it needs is per
      // person — each staff member connecting their own mailbox.
      label: "Email",
      state: "live",
      summary:
        "Live. Each staff member connects their Gmail or business mailbox (Connections); mail with their clients lands here and replies go out threaded.",
      requirements: [],
      canSend: true,
    },
    {
      channel: "sms",
      label: "SMS / RCS",
      // NOT live even with Twilio keys present: there is no SMS adapter in the
      // code yet — reply-dispatch refuses the channel. Saying "live" because an
      // env var exists would promise texts that can never leave.
      state: "needs-setup",
      summary: twilio
        ? "Twilio keys are present, but the SMS adapter is not built yet — texts cannot send or arrive."
        : "Not connected. SMS needs a paid provider (Twilio) and its adapter.",
      requirements: twilio
        ? ["The SMS send/receive adapter (a build on top of the Twilio account)."]
        : [
            "A Twilio (or compatible) account — a paid provider.",
            "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a TWILIO_SMS_FROM number in the server config.",
            "The SMS send/receive adapter.",
          ],
      canSend: false,
    },
    {
      channel: "phone",
      label: "Phone calls",
      state: "needs-setup",
      summary:
        "Call logging works now (calls show in the conversation timeline). Placing and recording calls needs a voice provider.",
      requirements: [
        "A Twilio Voice (or compatible) account — a paid provider — and a TWILIO_VOICE_FROM number.",
        "The calling adapter (click-to-call, recordings, transcripts).",
      ],
      // Call LOGGING needs no provider (its own feature); canSend here means
      // placing a live call, which no code can do yet.
      canSend: false,
    },
    {
      channel: "instagram",
      label: "Instagram DMs",
      state: "awaiting-approval",
      summary:
        "Connected and working for the app's testers. Answering the public's DMs needs Meta App Review of instagram_manage_messages.",
      requirements: [
        "Meta App Review for instagram_manage_messages (Advanced Access).",
        "Each business connecting its Instagram Business account (Connections).",
      ],
      canSend: true,
    },
    {
      channel: "facebook",
      label: "Facebook Page",
      state: "awaiting-approval",
      summary:
        "Connected and working for the app's testers. Answering the public's Messenger messages needs Meta App Review of pages_messaging.",
      requirements: [
        "Meta App Review for pages_messaging (Advanced Access).",
        "Each business connecting its Facebook Page (Connections).",
      ],
      canSend: true,
    },
  ];
}

/** One channel's status, or undefined for a name the platform does not know. */
export function channelStatus(channel: string): ChannelStatus | undefined {
  return channelStatuses().find((s) => s.channel === channel);
}
