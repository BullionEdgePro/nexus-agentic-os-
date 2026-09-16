import type { ConversationChannel } from "@nexus/shared";
import { gmailConfigured } from "./gmail.js";

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
 * to live with no code change. WhatsApp is the one channel that is unconditionally
 * live — it is what the whole platform already runs on.
 */
export function channelStatuses(): ChannelStatus[] {
  const email = gmailConfigured();
  const twilio = twilioConfigured();

  return [
    {
      channel: "whatsapp",
      label: "WhatsApp",
      state: "live",
      summary: "Live. Every conversation the platform runs on today.",
      requirements: [],
      canSend: true,
    },
    {
      channel: "email",
      // Honest about a half-built thing: the Gmail connection exists (staff can
      // already work their own clients' mail through it), but email is not yet a
      // threaded inbox channel — that build is next. So it is never "live" here
      // just because the app credentials are present.
      label: "Email",
      state: "needs-setup",
      summary: email
        ? "Gmail is connected for staff client mail. Email as a threaded inbox channel — send and receive here — is the next build."
        : "Ready. Connect Gmail to add email as an inbox channel — no extra cost.",
      requirements: email
        ? ["Finish the email-channel build (in progress).", "Each staff member connecting their Gmail."]
        : [
            "A Google Workspace app (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
            "Each staff member connecting their Gmail, then the email-channel build.",
          ],
      canSend: false,
    },
    {
      channel: "sms",
      label: "SMS / RCS",
      state: twilio ? "live" : "needs-setup",
      summary: twilio
        ? "Live. Texts send and receive through the connected Twilio number."
        : "Ready. Add a Twilio account and number to switch SMS on.",
      requirements: twilio
        ? []
        : [
            "A Twilio (or compatible) account — a paid provider.",
            "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a TWILIO_SMS_FROM number in the server config.",
          ],
      canSend: twilio,
    },
    {
      channel: "phone",
      label: "Phone calls",
      state: twilio ? "live" : "needs-setup",
      summary: twilio
        ? "Live. Calls place and log automatically through Twilio Voice."
        : "Call logging works now. Live calling and recordings need Twilio Voice.",
      requirements: twilio
        ? []
        : [
            "A Twilio Voice account — the same provider as SMS.",
            "A TWILIO_VOICE_FROM number in the server config.",
          ],
      // Call LOGGING already works with no provider (that is its own feature);
      // canSend here means placing a live call, which does need Twilio.
      canSend: twilio,
    },
    {
      channel: "instagram",
      label: "Instagram DMs",
      state: "awaiting-approval",
      summary: "Waiting on Meta. Instagram messaging needs App Review, the same wall as WhatsApp.",
      requirements: [
        "Meta Instagram App Review (instagram_manage_messages).",
        "A submission cannot be edited while one is in review — Instagram is added once the WhatsApp review resolves.",
      ],
      canSend: false,
    },
  ];
}

/** One channel's status, or undefined for a name the platform does not know. */
export function channelStatus(channel: string): ChannelStatus | undefined {
  return channelStatuses().find((s) => s.channel === channel);
}
