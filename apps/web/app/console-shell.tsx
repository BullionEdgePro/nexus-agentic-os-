"use client";

import { usePathname } from "next/navigation";
import { NAV, activeHref } from "@/lib/nav";
import { fontVariables } from "@/lib/fonts";
import "./deck/deck.css";
import "./console-shell.css";

/**
 * The frame every signed-in screen sits in.
 *
 * WHAT THIS REPLACES. Nexus was one product wearing several coats. The console
 * had a navigation rail; the nine screens it linked to had none, just a "←
 * Command deck" link back to where you came from — so reaching Follow-ups from
 * Operators meant going home first. And the inbox was a different visual world
 * altogether: Tailwind, near-black, no relation to the vellum-and-ink of
 * everything else. Two designs, one product, and a menu that existed on exactly
 * one page.
 *
 * Now there is one shell. It renders the same rail on every authenticated
 * screen, from one list (lib/nav.tsx), so a new screen appears everywhere the
 * moment it is added — and nothing can drift out of step with a second copy,
 * because there is no second copy.
 *
 * WHAT IT DELIBERATELY DOES NOT WRAP. The landing page, sign-in and the privacy
 * notice. A visitor who is not signed in has nowhere to navigate to, and a rail
 * full of links that all bounce off the auth middleware would be a menu of
 * closed doors. `/` decides for itself which face to show — see app/page.tsx.
 */
/**
 * The links themselves, so the front page and the shell cannot disagree.
 *
 * The front page builds its own grid — a header row above a rail — and this
 * shell does not. Rather than force one layout on both, they share the CONTENTS
 * of the rail and each positions it. That is the part that was drifting: the
 * items, not the geometry.
 */
export function RailLinks({ role }: { role: "operator" | "employee" }) {
  const pathname = usePathname();
  const current = activeHref(pathname);

  // An employee never sees a door they cannot open.
  //
  // `operatorOnly` was declared on three entries and read by nothing, so the
  // rail offered every employee Broadcasts, Team activity and Agent quality —
  // each of which the API refuses with a 403. A menu of closed doors is worse
  // than a shorter menu: it teaches the person that the product is broken
  // rather than that the screen is not theirs.
  const visible = role === "operator" ? NAV : NAV.filter((item) => !item.operatorOnly);

  return (
    <>
      {visible.map((item) => (
        <a
          key={item.href}
          href={item.href}
          title={item.label}
          className={item.href === current ? "on" : undefined}
          // The current page is announced, not merely coloured. A rail whose
          // only "you are here" is a background swap says nothing to anyone
          // navigating by keyboard or screen reader.
          aria-current={item.href === current ? "page" : undefined}
        >
          <span className="rail-icon">{item.icon}</span>
          <span className="rail-label">{item.label}</span>
        </a>
      ))}

      <span className="sep" />

      {/* Always a real link to a real route. It used to branch: a plain <a>
          doing a GET on the nine screens where onSignOut was not passed —
          against a route that only accepted POST, so those answered 405 — and
          an <a> with NO href on the front page, which a keyboard cannot
          reach. One path now, working without JavaScript, everywhere. */}
      <a href="/api/auth/logout" title="Sign out">
        <span className="rail-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
          </svg>
        </span>
        <span className="rail-label">Sign out</span>
      </a>
    </>
  );
}

export function ConsoleShell({
  children,
  role,
}: {
  children: React.ReactNode;
  role: "operator" | "employee";
}) {
  return (
    <div className={`deck-root shell ${fontVariables}`}>
      <nav className="rail shell-rail" aria-label="Sections">
        {/* The mark, then the destinations. An icon-only strip made everyone
            hover each square to find out what it was — the label IS the
            navigation, the glyph is only there to make a familiar one findable
            at a glance. */}
        <a className="rail-brand" href="/" title="Nexus Agentic OS">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="currentColor" strokeWidth="1.3" />
            <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" stroke="var(--signal)" strokeWidth="1.2" />
            <circle cx="16" cy="16" r="2" fill="var(--signal)" />
          </svg>
          <span className="rail-wordmark">Nexus</span>
        </a>
        <RailLinks role={role} />
      </nav>
      <main className="shell-main">{children}</main>
    </div>
  );
}
