"use client";

import { useEffect } from "react";

/**
 * Registers Nexus's service worker once, from the root, so the whole site is
 * one installable app and pushes can reach it (spec 2026-10-09). Renders
 * nothing. A browser without service workers simply keeps working as a
 * website.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Not fatal: the site works without it, it just can't install or alert.
    });
  }, []);
  return null;
}
