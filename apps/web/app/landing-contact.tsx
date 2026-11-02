import type { SalesContact } from "@/lib/sales-contact";

/**
 * The storefront's contact button (spec 2026-11-02-storefront-cream-design.md
 * §2). One component for every place it appears — the top bar, the headline,
 * the closing band, the phone's floating pill — so they can never disagree
 * about where the visitor is sent.
 *
 * A real link whose words say where it goes: "Chat on WhatsApp" opens WhatsApp
 * in a new tab, "Email us" opens the visitor's mail app in place.
 */
export function ContactButton({
  contact,
  whatsappLabel,
  className = "btn",
}: {
  contact: SalesContact;
  whatsappLabel: string;
  className?: string;
}) {
  if (contact.kind === "whatsapp") {
    return (
      <a className={`${className} lp-contact`} href={contact.href} target="_blank" rel="noopener">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4.5 19.5 5.6 16A8 8 0 1 1 8.4 18.6Z" />
          <path d="M9.2 9.4c.3 1.9 1.6 3.4 3.6 4.3l1.2-1.1 1.8.8-.3 1.4c-3.3.1-6.5-2.8-6.9-6.2l1.4-.5.9 1.7Z" />
        </svg>
        <span>{whatsappLabel}</span>
      </a>
    );
  }
  return (
    <a className={`${className} lp-contact`} href={contact.href}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
      <span>Email us</span>
    </a>
  );
}

/**
 * The last ask before the team's sign-in: one line and the button again. The
 * line is honest about which button it is — it only promises a number Nexus
 * answers when there is one.
 */
export function ClosingBand({ contact }: { contact: SalesContact }) {
  return (
    <section className="lp-close" id="talk" aria-labelledby="talk-h">
      <span className="lp-kicker">See it on your own business</span>
      <h2 id="talk-h">Talk to the agent yourself</h2>
      <p>
        {contact.kind === "whatsapp"
          ? "The button opens WhatsApp to a number Nexus answers — ask it what a customer would."
          : "Write to us and we'll show you Nexus on your own business."}
      </p>
      <ContactButton contact={contact} whatsappLabel="Chat with Nexus on WhatsApp" />
    </section>
  );
}
