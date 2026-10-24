"use client";

import { usePathname } from "next/navigation";
import { TeamChatBadge } from "./team-chat-alerts";
import "./mobile-tabs.css";

/**
 * A staff member's phone (24 Oct 2026, Focus workspace): four tabs at the
 * bottom, where a thumb reaches — the queue, the team, promises, and home.
 * Shown under 760px only; the sidebar is still there for everything else.
 */
const TABS = [
  { href: "/inbox", label: "Queue", d: "M4 5h16v11H8l-4 4V5Z" },
  {
    href: "/deck/team-chat",
    label: "Team",
    d: "M17 9h2a2 2 0 0 1 2 2v8l-3-2h-6a2 2 0 0 1-2-2v-1M3 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7l-4 3V5Z",
  },
  { href: "/deck/tasks", label: "Follow-ups", d: "m9 11 3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11" },
  { href: "/", label: "Me", d: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9c1-4 4-6 8-6s7 2 8 6" },
];

export function MobileTabs() {
  const pathname = usePathname();
  return (
    <nav className="mtabs" aria-label="Main">
      {TABS.map((tab) => {
        const on = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <a key={tab.href} href={tab.href} className={on ? "on" : undefined} aria-current={on ? "page" : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={tab.d} />
            </svg>
            <span>{tab.label}</span>
            {tab.href === "/deck/team-chat" ? <TeamChatBadge /> : null}
          </a>
        );
      })}
    </nav>
  );
}
