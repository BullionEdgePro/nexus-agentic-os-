"use client";

import { useEffect } from "react";
import { countUp, parseCount, setPopOrigin } from "@/lib/motion";
import { installSoundBridge, play } from "@/lib/sound";
import { RAIL_FROM_KEY } from "@/lib/rail";

/**
 * Starts the motion and sound kit on every signed-in screen (spec
 * 2026-11-01-cream-foundation-design.md §3–4). Mounted once by ConsoleShell.
 * Renders nothing; everything it starts, it stops on unmount.
 *
 *  - counts a [data-countup] figure up the first time it is a number on
 *    screen — on load, or when its live value arrives later;
 *  - remembers where the last press was, so a window grows out of it;
 *  - plays a whoosh on a sidebar click and notes the page being left, so the
 *    next page's pill slides from there;
 *  - pops when a window or side panel opens or closes;
 *  - answers `nexus:sound` events from any screen.
 */
export function MotionBoot() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: Array<() => void> = [installSoundBridge(window)];

    // ---- count-up ----
    const ready = (el: HTMLElement) =>
      !el.dataset.counted && el.firstChild?.nodeType === Node.TEXT_NODE && parseCount(el.firstChild.nodeValue ?? "") !== null;
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (entry.isIntersecting && ready(el)) {
          seen.unobserve(el);
          countUp(el);
        }
      }
    });
    const watch = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>("[data-countup]").forEach((el) => {
        if (!el.dataset.counted) seen.observe(el);
      });
    };
    if (!reduce) {
      watch(document);
      // A figure that arrives after load (live data) is watched once it is a number.
      const changes = new MutationObserver((records) => {
        for (const record of records) {
          const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
          const host = target?.closest<HTMLElement>("[data-countup]");
          if (host && ready(host)) {
            seen.unobserve(host);
            seen.observe(host);
          } else if (target) watch(target);
        }
      });
      changes.observe(document.body, { childList: true, subtree: true, characterData: true });
      cleanups.push(() => changes.disconnect());
    }
    cleanups.push(() => seen.disconnect());

    // ---- where windows grow from ----
    const press = (e: PointerEvent) => setPopOrigin(e.clientX, e.clientY);
    document.addEventListener("pointerdown", press, true);
    cleanups.push(() => document.removeEventListener("pointerdown", press, true));

    // ---- the sidebar: whoosh, and remember the page being left ----
    const railClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.(".shell-rail a[href]");
      if (!link || link.classList.contains("on")) return;
      const here = document.querySelector<HTMLAnchorElement>(".shell-rail a.on");
      try {
        if (here) sessionStorage.setItem(RAIL_FROM_KEY, here.getAttribute("href") ?? "");
      } catch {
        // Blocked storage: the next page's pill is simply placed, not slid.
      }
      play("whoosh");
    };
    document.addEventListener("click", railClick);
    cleanups.push(() => document.removeEventListener("click", railClick));

    // ---- windows and panels pop ----
    const isPanel = (n: Node) =>
      n instanceof Element && (n.matches(".nx-pop, .nx-sheet") || n.querySelector(".nx-pop, .nx-sheet") !== null);
    const panels = new MutationObserver((records) => {
      for (const record of records) {
        if ([...record.addedNodes].some(isPanel)) play("pop");
        else if ([...record.removedNodes].some(isPanel)) play("pop", { close: true });
      }
    });
    panels.observe(document.body, { childList: true, subtree: true });
    cleanups.push(() => panels.disconnect());

    return () => cleanups.forEach((stop) => stop());
  }, []);

  return null;
}
