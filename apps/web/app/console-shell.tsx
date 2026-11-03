"use client";

import { ThemeToggle } from "./theme-toggle";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ViewAsStaff } from "./view-as-staff";
import { Assistant } from "./assistant";
import { CommandPalette } from "./command-palette";
import { AssignmentAlerts } from "./assignment-alerts";
import { TeamChatAlerts, TeamChatBadge } from "./team-chat-alerts";
import { MobileTabs } from "./mobile-tabs";
import { InstallBanner } from "./install-app";
import { MotionBoot } from "./motion-boot";
import { SoundToggle } from "./sound-toggle";
import { play } from "@/lib/sound";
import { RAIL_FROM_KEY, RAIL_KEY, readRailMode, type RailMode } from "@/lib/rail";
import { NAV, NAV_GROUPS, activeHref, toneOf } from "@/lib/nav";
import { workflowFor } from "@nexus/shared";
import { HeaderSearch, WorkMenu, NotificationsMenu, AccountMenu } from "./header-menus";
import { fontVariables } from "@/lib/fonts";
import "./deck/deck.css";
import "./console-shell.css";
import "./motion.css";

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
export function RailLinks({ role, mySlug = null }: { role: "operator" | "employee"; mySlug?: string | null }) {
  const pathname = usePathname();
  const current = activeHref(pathname);

  // An employee never sees a door they cannot open.
  //
  // `operatorOnly` was declared on three entries and read by nothing, so the
  // rail offered every employee Broadcasts, Team activity and Agent quality —
  // each of which the API refuses with a 403. A menu of closed doors is worse
  // than a shorter menu: it teaches the person that the product is broken
  // rather than that the screen is not theirs.
  // Both directions, for the same reason: a door that answers "this is not
  // yours" teaches that the product is broken rather than that the screen is
  // somebody else's.
  const labelFor = (item: (typeof NAV)[number]) => (role === "employee" && item.staffLabel) || item.label;

  const visible =
    role === "operator"
      ? NAV.filter((item) => !item.staffOnly)
      : NAV.filter((item) => !item.operatorOnly).filter(
          // The workflow audit only for staff whose business has a workflow drawn.
          (item) => !item.needsWorkflow || (mySlug !== null && workflowFor(mySlug) !== null)
        );

  // The link itself, so the grouped run and the fallback render it identically.
  const link = (item: (typeof NAV)[number]) => (
    <a
      key={item.href}
      href={item.href}
      title={labelFor(item)}
      className={item.href === current ? "on" : undefined}
      // The current page is announced, not merely coloured. A rail whose
      // only "you are here" is a background swap says nothing to anyone
      // navigating by keyboard or screen reader.
      aria-current={item.href === current ? "page" : undefined}
    >
      {/* A glass tile in its section's colour, like an app on a home screen. */}
      <span className="rail-icon" data-tone={toneOf(item.href)}>{item.icon}</span>
      <span className="rail-label">{labelFor(item)}</span>
      {item.href === "/deck/team-chat" ? <TeamChatBadge /> : null}
    </a>
  );

  // Render group by group, in the order the sections argue for. An item the
  // role cannot see drops out; a group left empty by that renders no heading.
  const visibleSet = new Set(visible.map((i) => i.href));
  const byHref = new Map(NAV.map((i) => [i.href, i] as const));
  const grouped = new Set<string>();

  return (
    <>
      {NAV_GROUPS.map((group) => {
        const items = group.hrefs
          .map((href) => byHref.get(href))
          .filter((item): item is NonNullable<typeof item> => !!item && visibleSet.has(item.href));
        if (items.length === 0) return null;
        items.forEach((i) => grouped.add(i.href));
        return (
          <Fragment key={group.title}>
            {/* A quiet section label, not a control — the heading names the run
                below it and is skipped by the tab order and the screen reader,
                which reach the links themselves. */}
            <span className="rail-group" aria-hidden="true">
              {group.title}
            </span>
            {items.map(link)}
          </Fragment>
        );
      })}

      {/* Any visible screen that no group claims still gets a door — a new NAV
          entry must never be invisible just because it was not filed here. */}
      {visible.filter((item) => !grouped.has(item.href)).map(link)}

      {/* The account, not a destination (22 Oct 2026): sign-out sat in the
          list like a screen. It now closes the rail, under who is signed in.
          Always a real link to a real route, working without JavaScript. */}
      <div className="rail-foot">
        {/* Who is signed in gets a row of its own (2 Nov 2026): on one line
            with the switches and Sign out, the name was squeezed to a sliver
            and the sky switch drew over it. */}
        <span className="rail-foot-who">
          <span className="rail-foot-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {role === "operator" ? (
                <path d="M4 18h16M5 18l-1-9 4.5 3.5L12 6l3.5 6.5L20 9l-1 9" />
              ) : (
                <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0" />
              )}
            </svg>
          </span>
          <span className="rail-foot-text">
            <span className="rail-foot-name">{role === "operator" ? "Admin" : "Staff"}</span>
            <span className="rail-foot-role">{role === "operator" ? "All businesses" : "Your own work"}</span>
          </span>
        </span>
        {/* Light or dark, and sound on or off, beside the way out. */}
        <div className="rail-foot-controls">
          <ThemeToggle compact />
          <SoundToggle />
          <a href="/api/auth/logout" title="Sign out">
            <span className="rail-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
              </svg>
            </span>
            <span className="rail-label">Sign out</span>
          </a>
        </div>
      </div>
    </>
  );
}

/**
 * « — shrink the dock to the video's icon-only strip, or open it again.
 * THEME_BOOT applies the saved choice before paint; this keeps it.
 */
function RailCollapse() {
  const [mode, setMode] = useState<RailMode>("full");

  useEffect(() => setMode(readRailMode(() => localStorage.getItem(RAIL_KEY))), []);

  function toggle() {
    const next: RailMode = mode === "icons" ? "full" : "icons";
    const root = document.documentElement;
    if (next === "icons") root.setAttribute("data-rail", "icons");
    else root.removeAttribute("data-rail");
    try {
      localStorage.setItem(RAIL_KEY, next);
    } catch {
      // Blocked storage: the choice lasts for this page only.
    }
    setMode(next);
    play("tick");
  }

  const shrunk = mode === "icons";
  return (
    <button
      type="button"
      className="rail-collapse"
      onClick={toggle}
      aria-pressed={shrunk}
      aria-label={shrunk ? "Expand sidebar" : "Shrink sidebar"}
      title={shrunk ? "Expand sidebar" : "Shrink sidebar"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
      </svg>
    </button>
  );
}

/** useLayoutEffect in the browser, nothing on the server (where it warns). */
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The cream pill behind the current page's link.
 *
 * One element, moved — not a background on each link — so it can slide. On
 * load it starts where the person clicked on the previous page (MotionBoot
 * notes that href under RAIL_FROM_KEY) and slides here; with nothing noted, or
 * under reduced motion, it is simply placed. Until it is placed, the link wears
 * the cream itself, so the first paint already shows where you are.
 */
/**
 * The page the person just left, read once per page.
 *
 * Kept here rather than re-read in the effect: React runs a layout effect twice
 * in development, and the first run removing the key left the second with
 * nothing to slide from. Keyed by path, so a later client-side page change does
 * not reuse an old start point.
 */
let railFrom: { path: string; href: string | null } | null = null;
function takeRailFrom(path: string): string | null {
  if (railFrom?.path !== path) {
    let href: string | null = null;
    try {
      href = sessionStorage.getItem(RAIL_FROM_KEY);
      sessionStorage.removeItem(RAIL_FROM_KEY);
    } catch {
      // Blocked storage: no slide, just the pill in place.
    }
    railFrom = { path, href };
  }
  return railFrom.href;
}

function RailPill() {
  const ref = useRef<HTMLSpanElement>(null);
  const pathname = usePathname() ?? "";

  useBrowserLayoutEffect(() => {
    const pill = ref.current;
    const nav = pill?.parentElement;
    if (!pill || !nav) return;
    const current = nav.querySelector<HTMLElement>(":scope > a.on");
    if (!current) {
      delete nav.dataset.pill;
      return;
    }

    const place = (link: HTMLElement) => {
      pill.style.setProperty("--pill-x", `${link.offsetLeft}px`);
      pill.style.setProperty("--pill-y", `${link.offsetTop}px`);
      pill.style.setProperty("--pill-w", `${link.offsetWidth}px`);
      pill.style.setProperty("--pill-h", `${link.offsetHeight}px`);
    };

    // Only the dock's own destinations: the logo and the foot's sign-out are
    // links too, and a slide must never start from either.
    const fromHref = takeRailFrom(pathname);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from =
      !reduce && fromHref
        ? [...nav.querySelectorAll<HTMLElement>(":scope > a[href]")].find((a) => a.getAttribute("href") === fromHref && a !== current) ?? null
        : null;

    // On a phone the dock is a sideways-scrolling bar: bring this page's icon
    // into view, so the pill is never off the end of it.
    if (nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
    }

    // First placement (or a fresh start point) without a transition; a pill
    // already showing slides on from where it is (a client-side page change).
    if (from || nav.dataset.pill !== "ready") {
      pill.classList.remove("sliding");
      place(from ?? current);
    }
    nav.dataset.pill = "ready";
    document.documentElement.removeAttribute("data-rail-from");
    // Commit that position as the start of the slide, then slide. The class
    // goes on before the ResizeObserver below exists, so its first call (which
    // always comes, before paint) cannot snap the pill home un-animated.
    void pill.offsetWidth;
    if (!reduce) pill.classList.add("sliding");
    place(current);

    // Follow the link when the dock changes size: shrunk, opened, rotated phone.
    const resize = new ResizeObserver(() => place(current));
    resize.observe(nav);
    return () => resize.disconnect();
  }, [pathname]);

  return <span ref={ref} className="rail-pill" aria-hidden="true" />;
}

export function ConsoleShell({
  children,
  role,
  me,
  signedInAs,
}: {
  children: React.ReactNode;
  role: "operator" | "employee";
  /** Who is signed in, for the admin's account menu. */
  signedInAs?: string;
  /** A signed-in staff member — who "a chat is now yours" alerts are for. */
  me?: { employeeId: string; organizationSlug: string } | null;
}) {
  // The inbox is a full-screen workspace with its own header: the admin's top
  // bar would push its composer below the fold, so it is left off there.
  const pathname = usePathname() ?? "";
  return (
    <div className={`deck-root shell ${fontVariables}`}>
      <nav className="rail shell-rail" aria-label="Sections">
        {/* The mark, then the destinations. An icon-only strip made everyone
            hover each square to find out what it was — the label IS the
            navigation, the glyph is only there to make a familiar one findable
            at a glance. */}
        <div className="rail-brand-row">
          <a className="rail-brand" href="/" title="Nexus Agentic OS">
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M16 2 3 9v14l13 7 13-7V9L16 2Z" stroke="currentColor" strokeWidth="1.3" />
              <path d="M16 9 9 12.5v7L16 23l7-3.5v-7L16 9Z" stroke="var(--signal)" strokeWidth="1.2" />
              <circle cx="16" cy="16" r="2" fill="var(--signal)" />
            </svg>
            <span className="rail-wordmark">nexus</span>
          </a>
          {/* « shrinks the dock to icons; the theme switch moved to the foot. */}
          <RailCollapse />
        </div>
        {/* A visible way in to the search that ⌘K already opened — the shortcut
            is fast once known and invisible until then, so the box makes it
            findable. It dispatches the same event the palette listens for, so
            there is one search with two triggers, not two searches. */}
        <button
          type="button"
          className="rail-search"
          onClick={() => window.dispatchEvent(new CustomEvent("nexus:open-search"))}
          title="Search (⌘K)"
        >
          <svg className="rail-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <span className="rail-search-label">Search</span>
          <kbd className="rail-search-kbd" aria-hidden="true">⌘K</kbd>
        </button>
        <RailPill />
        <RailLinks role={role} mySlug={me?.organizationSlug ?? null} />
      </nav>
      <main className="shell-main">
        {/* The admin's tools on every page — search, work, notifications, account —
            which used to exist only on the front page's own header. Staff
            have none of these menus. */}
        {role === "operator" && !pathname.startsWith("/inbox") ? (
          <header className="shell-top">
            {/* The admin's search across customers and conversations — wider
                than the dock's ⌘K palette, which finds screens. */}
            <HeaderSearch />
            <WorkMenu />
            <NotificationsMenu />
            <AccountMenu signedInAs={signedInAs ?? ""} />
          </header>
        ) : null}
        {/* Operator-only, and above everything: a narrowed console is
            indistinguishable from a quiet one unless something says so on every
            page. See ViewAsStaff. */}
        {role === "operator" ? <ViewAsStaff /> : null}
        {/* A staff phone hides the dock for its four tabs (mobile-tabs.tsx), so
            light/dark and mute come along here instead — staff are the ones
            the pings are for. Shown only at phone width. */}
        {role === "employee" ? (
          <div className="shell-phone-tools">
            <ThemeToggle compact />
            <SoundToggle />
          </div>
        ) : null}
        {/* Offers to install Nexus as an app; shows nothing once installed. */}
        <InstallBanner />
        {children}
      </main>
      {/* Every signed-in screen, both roles. It sits outside <main> because it
          is fixed to the viewport rather than part of the page's flow, and
          starts closed so it is never in the way of the work. */}
      <Assistant />
      {/* ⌘K / Ctrl-K from anywhere signed in. Role-filtered like the rail. */}
      <CommandPalette role={role} mySlug={me?.organizationSlug ?? null} />
      {/* The motion and sound kit, once per signed-in screen. */}
      <MotionBoot />
      {/* "New chat for you" — wherever a staff member is in the product. */}
      {/* Team chat's unread count and @mention alerts, both roles. */}
      <TeamChatAlerts employeeId={role === "employee" ? (me?.employeeId ?? null) : null} />
      {/* A staff member's phone: Queue, Team, Follow-ups, Me at the bottom. */}
      {role === "employee" ? <MobileTabs /> : null}
      {role === "employee" && me ? (
        <AssignmentAlerts employeeId={me.employeeId} organizationSlug={me.organizationSlug} />
      ) : null}
    </div>
  );
}
