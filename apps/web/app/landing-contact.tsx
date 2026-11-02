"use client";

import { useEffect, useRef, useState } from "react";
import type { SalesContact } from "@/lib/sales-contact";

/**
 * The storefront's contact button (spec 2026-11-02-storefront-cream-design.md
 * §2). One component for every place it appears — the top bar, the headline,
 * the closing band, the phone's floating pill — so they can never disagree
 * about where the visitor is sent.
 *
 * A real link whose words say where it goes: "Chat on WhatsApp" opens WhatsApp
 * in a new tab, "Email us" opens the visitor's mail app in place. A phone's top
 * bar has no room for the whole label, so it can carry a short one ("WhatsApp")
 * that only a phone shows (landing.css).
 */
export function ContactButton({
  contact,
  whatsappLabel,
  shortLabel,
  className = "btn",
}: {
  contact: SalesContact;
  whatsappLabel: string;
  shortLabel?: string;
  className?: string;
}) {
  if (contact.kind === "whatsapp") {
    return (
      <a className={`${className} lp-contact`} href={contact.href} target="_blank" rel="noopener">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4.5 19.5 5.6 16A8 8 0 1 1 8.4 18.6Z" />
          <path d="M9.2 9.4c.3 1.9 1.6 3.4 3.6 4.3l1.2-1.1 1.8.8-.3 1.4c-3.3.1-6.5-2.8-6.9-6.2l1.4-.5.9 1.7Z" />
        </svg>
        {shortLabel ? (
          <>
            <span className="lp-contact-long">{whatsappLabel}</span>
            <span className="lp-contact-short">{shortLabel}</span>
          </>
        ) : (
          <span>{whatsappLabel}</span>
        )}
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

/**
 * A phone's section links, folded behind one button (landing.css shows it
 * under 760 px only). A real disclosure: the button says whether the list is
 * open, Escape closes it and puts focus back on the button, and choosing a link
 * or pressing anywhere else closes it too.
 */
export function NavMenu({ links }: { links: Array<{ href: string; label: string }> }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="lp-menu" ref={rootRef}>
      <button
        type="button"
        className="lp-menu-btn"
        aria-expanded={open}
        aria-controls="lp-menu"
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        <span className="lp-sr">Menu</span>
      </button>
      <ul id="lp-menu" className="lp-menu-list" hidden={!open}>
        {links.map((l) => (
          <li key={l.href}>
            <a href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The floating pill shows once the headline has gone, and steps aside for the closing band's own button. */
export function floatVisible(heroInView: boolean, closeInView: boolean): boolean {
  return !heroInView && !closeInView;
}

/**
 * A phone's WhatsApp pill that follows the reader down the page (landing.css
 * shows it under 760 px only). Nothing is drawn until the page has been
 * watched — so the server, and a browser without IntersectionObserver, draw
 * nothing at all rather than a pill that never moves.
 */
export function FloatingContact({ contact }: { contact: SalesContact }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const hero = document.getElementById("top");
    const close = document.getElementById("talk");
    if (!hero || !close) return;
    const seen = { hero: true, close: false };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === hero) seen.hero = entry.isIntersecting;
        else seen.close = entry.isIntersecting;
      }
      setShow(floatVisible(seen.hero, seen.close));
    });
    observer.observe(hero);
    observer.observe(close);
    return () => observer.disconnect();
  }, []);

  if (!show) return null;
  return (
    <div className="lp-float-contact">
      <ContactButton contact={contact} whatsappLabel="Chat on WhatsApp" />
    </div>
  );
}
