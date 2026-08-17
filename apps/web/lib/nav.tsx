import type { ReactNode } from "react";

/**
 * Every place you can go in Nexus, defined exactly once.
 *
 * This list used to live inline in deck-console.tsx, which meant it existed on
 * the front page and nowhere else. Open Follow-ups and the navigation vanished:
 * the only way to reach Operators was to go back to the front page first. Nine
 * screens, one of which had a menu.
 *
 * Now the shell renders this on every signed-in page, so adding a screen means
 * adding one entry here and the whole product knows about it.
 *
 * ORDER IS THE ARGUMENT, not decoration. It runs from what a customer is doing
 * right now, through what the platform noticed on its own, to the material the
 * agents answer from, and finally to reporting. Someone scanning the rail top to
 * bottom is reading the product's own priorities — which is why "Needs
 * attention" sits second and reporting sits last.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Operators only. An employee reaching these gets a 403 from the API. */
  operatorOnly?: boolean;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const NAV: NavItem[] = [
  {
    href: "/",
    label: "Overview",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="5" rx="1.5" />
        <rect x="13" y="10" width="8" height="11" rx="1.5" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" />
      </svg>
    ),
  },
  {
    href: "/inbox",
    label: "Conversations",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
      </svg>
    ),
  },
  {
    href: "/deck/operators",
    label: "Needs attention",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M12 3.8 21 20H3l9-16.2Z" />
        <path d="M12 10v4.2M12 17.1v.1" />
      </svg>
    ),
  },
  {
    href: "/deck/tasks",
    label: "Follow-ups",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M9 5h10M9 12h10M9 19h10" />
        <path d="M3.5 5.2l1.4 1.4L7.6 3.8M3.5 12.2l1.4 1.4 2.7-2.8" />
        <path d="M3.2 18.2h3.6" />
      </svg>
    ),
  },
  {
    href: "/deck/bookings",
    label: "Appointments",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
        <path d="M9.2 14.6l1.6 1.6 3.6-3.6" />
      </svg>
    ),
    // Deliberately NOT operatorOnly. The person who has been booked is the
    // person who needs the diary — /api/bookings narrows an employee to their
    // own business inside the route, exactly as follow-ups does.
  },
  {
    href: "/deck/team",
    label: "Team",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <circle cx="9" cy="8" r="3.1" />
        <path d="M2.5 20c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6" />
        <path d="M16.5 5.6a3.1 3.1 0 0 1 0 5.9M18 14.8c2.1.7 3.5 2.5 3.5 5.2" />
      </svg>
    ),
  },
  {
    href: "/deck/knowledge",
    label: "Knowledge",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
        <path d="M8 7.5h7M8 11h5" />
      </svg>
    ),
  },
  {
    href: "/deck/procedures",
    label: "How we answer",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M5 5.5h3M5 12h3M5 18.5h3" />
        <path d="M11.5 5.5H19M11.5 12H19M11.5 18.5H19" />
      </svg>
    ),
    // Sits directly after Knowledge, and the pairing is the argument: knowledge
    // is what the agent answers FROM, this is the order it answers IN. Deliberately
    // NOT operatorOnly, for the same reason Knowledge is not — it is the
    // business's own material, and the person who knows whether "ask which
    // country first" is right is the person who does the job.
  },
  {
    href: "/deck/catalogue",
    label: "Catalogue",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <rect x="3" y="4" width="7" height="7" rx="1.2" />
        <rect x="14" y="4" width="7" height="7" rx="1.2" />
        <rect x="3" y="15" width="7" height="5" rx="1.2" />
        <path d="M17.5 14.5v6M14.5 17.5h6" />
      </svg>
    ),
    // Third in the material group, after Knowledge and How we answer, because
    // it is where both of those can come from ready-made.
    //
    // Operator-only, and it is the one entry in this group that is. Knowledge
    // and procedures are the business's own material and the person doing the
    // job is trusted with them. Installing a pack changes what every customer
    // of that business is eventually told, and this screen shows all five
    // businesses side by side — an owner's decision on an owner's view.
    // /api/catalog refuses employees, so the rail must not offer it.
    operatorOnly: true,
  },
  {
    href: "/deck/links",
    label: "Customer links",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M10 13a4 4 0 0 0 5.7.4l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7" />
        <path d="M14 11a4 4 0 0 0-5.7-.4l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7" />
      </svg>
    ),
    // /api/links is operatorOnly server side. Without this an employee saw the
    // tab, opened it, and got the error state — the deep links are one set for
    // the whole platform, spanning every business, so there is nothing here
    // scoped to theirs to show even in principle.
    operatorOnly: true,
  },
  {
    href: "/deck/broadcasts",
    label: "Broadcasts",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M3 11l18-8-8 18-2-8-8-2Z" />
      </svg>
    ),
    operatorOnly: true,
  },
  {
    href: "/deck/activity",
    label: "Team activity",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M3 12h3.5l2.5-6 3.5 13 2.5-7h6" />
      </svg>
    ),
    operatorOnly: true,
  },
  {
    href: "/deck/forecast",
    label: "What's coming",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M3 16.5l5-5 3.5 3.5L21 6" />
        <path d="M15.5 6H21v5.5" />
        <path d="M3 20.5h18" strokeDasharray="2.5 2.5" />
      </svg>
    ),
    // Reporting, so it sits at the end — but deliberately NOT operatorOnly,
    // unlike the three screens around it. Those hold management information
    // about staff. How many customers are expected on Thursday is the business's
    // own operational information, and the person rostering Thursday is the one
    // who needs it. /api/organizations/:slug/forecast narrows an employee to
    // their own business, exactly as Knowledge and the diary do.
  },
  {
    href: "/deck/quality",
    label: "Agent quality",
    icon: (
      <svg viewBox="0 0 24 24" {...stroke}>
        <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />
      </svg>
    ),
    operatorOnly: true,
  },
];

/**
 * Which nav entry a path belongs to.
 *
 * Longest match wins, so `/deck/tasks` highlights Follow-ups rather than
 * Overview — "/" is a prefix of everything and would otherwise always win.
 */
export function activeHref(pathname: string): string {
  const match = NAV.filter((item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match?.href ?? "/";
}
