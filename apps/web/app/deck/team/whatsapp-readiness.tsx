"use client";

import { useEffect, useState } from "react";
import { getChannels, type ChannelStatus } from "@/lib/api";

/**
 * Who answers WhatsApp on their own number — the owner's checklist.
 *
 * Since 6 Oct 2026 there is no shared line: a customer who writes to a staff
 * member's WhatsApp Business number is that person's chat, and somebody with no
 * number of their own receives no WhatsApp at all. So the useful view is not a
 * setting but a roll call — who is connected, who is not — and a message the
 * owner can paste to the ones who are not, instead of explaining it six times.
 */
const INSTRUCTIONS = [
  "Connect your WhatsApp Business number to Nexus:",
  "1. Open https://app.nexusagenticos.com and sign in with your staff access code.",
  "2. Open Connections (under Settings), then WhatsApp → Connect WhatsApp.",
  "3. Log in with Facebook, pick your WhatsApp Business account and number, and enter the code WhatsApp sends to your phone.",
  "Keep using the WhatsApp Business app on your phone as normal. Your chats also appear in Nexus, and every customer who messages your number is yours.",
].join("\n");

interface Member {
  id: string;
  fullName: string;
  whatsappPhoneNumberId?: string | null;
}

export function WhatsAppReadiness({ team }: { team: Member[] }) {
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getChannels()
      .then((data) => {
        if (!cancelled) setStatus(data.channels.find((channel) => channel.channel === "whatsapp") ?? null);
      })
      .catch(() => {
        // The roll call below still stands on its own; the summary is extra.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (team.length === 0) return null;
  const connected = team.filter((member) => member.whatsappPhoneNumberId).length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTRUCTIONS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="wa-ready" aria-label="WhatsApp on their own numbers">
      <div className="wa-ready-head">
        <h3>WhatsApp numbers</h3>
        <span className={`wa-ready-count ${connected === team.length ? "done" : ""}`}>
          {connected} of {team.length} connected
        </span>
      </div>
      {/* The platform-wide count belongs on Channels; here it would sit beside
          this business's own count and read as a contradiction. */}
      {status && /switched off/.test(status.summary) ? (
        <p className="wa-ready-sum">
          The shared company number was switched off, so anyone below who is not connected gets no
          WhatsApp at all.
        </p>
      ) : null}
      <ul className="wa-ready-list">
        {team.map((member) => (
          <li key={member.id} className={member.whatsappPhoneNumberId ? "on" : ""}>
            <span className="wa-ready-dot" aria-hidden="true" />
            <span className="wa-ready-name">{member.fullName}</span>
            <span className="wa-ready-state">
              {member.whatsappPhoneNumberId ? "answers on their own number" : "not connected — gets no WhatsApp"}
            </span>
          </li>
        ))}
      </ul>
      {connected < team.length ? (
        <div className="wa-ready-actions">
          <button type="button" className="btn small" onClick={copy}>
            {copied ? "Copied" : "Copy instructions for staff"}
          </button>
          {status?.requirements.some((line) => line.includes("Meta")) ? (
            <span className="wa-ready-note">Connecting finishes once Meta fixes their onboarding bug.</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
