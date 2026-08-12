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
 *
 * `onSignOut` exists because the front page signs out through a client handler
 * that also clears local state, while a plain page can just follow the link.
 */
export function RailLinks({ onSignOut }: { onSignOut?: () => void }) {
  const pathname = usePathname();
  const current = activeHref(pathname);

  return (
    <>
      {NAV.map((item) => (
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
          {item.icon}
          <span className="tip">{item.label}</span>
        </a>
      ))}

      <span className="sep" />

      <a
        href={onSignOut ? undefined : "/api/auth/logout"}
        onClick={onSignOut}
        title="Sign out"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
        </svg>
        <span className="tip">Sign out</span>
      </a>
    </>
  );
}

export function ConsoleShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={`deck-root shell ${fontVariables}`}>
      <nav className="rail shell-rail" aria-label="Sections">
        <RailLinks />
      </nav>
      <main className="shell-main">{children}</main>
    </div>
  );
}
