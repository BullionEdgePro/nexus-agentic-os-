"use client";

import { useEffect, useState } from "react";

/**
 * The offer to install Nexus as an app (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Two platforms, two mechanisms:
 * - Chrome/Edge/Android raise `beforeinstallprompt`; we hold it and show an
 *   Install button that replays it.
 * - iPhone Safari has no prompt at all; we link to the step-by-step guide on
 *   /app, because Add to Home Screen is the only way in.
 * Nothing shows once Nexus is already running installed, or after a dismissal
 * (remembered per browser). The decision is a pure function so it is tested
 * directly.
 */
export type InstallChoice = "none" | "prompt" | "ios-guide";

export function installChoice(input: {
  ua: string;
  standalone: boolean;
  dismissed: boolean;
  promptAvailable: boolean;
}): InstallChoice {
  if (input.standalone || input.dismissed) return "none";
  if (input.promptAvailable) return "prompt";
  if (/iPhone|iPad|iPod/.test(input.ua)) return "ios-guide";
  return "none";
}

const DISMISSED_KEY = "nexus.installDismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function InstallBanner() {
  // Null until mounted: the server cannot know the device, and rendering an
  // offer the browser then removes is a flash.
  const [choice, setChoice] = useState<InstallChoice | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const decide = (promptAvailable: boolean) =>
      setChoice(
        installChoice({ ua: navigator.userAgent, standalone: isStandalone(), dismissed: readDismissed(), promptAvailable })
      );
    decide(false);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      decide(true);
    };
    const onInstalled = () => setChoice("none");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!choice || choice === "none") return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Private mode: it simply shows again next visit.
    }
    setChoice("none");
  };

  return (
    <aside className="install-banner" role="note" aria-label="Install Nexus">
      <img src="/icons/icon-192.png" alt="" width={32} height={32} />
      <p>
        {choice === "prompt"
          ? "Install Nexus for instant alerts on your own chats."
          : "Get Nexus on your iPhone for instant alerts on your own chats."}
      </p>
      {choice === "prompt" ? (
        <button
          type="button"
          className="install-go"
          onClick={async () => {
            if (!deferred) return;
            await deferred.prompt();
            const { outcome } = await deferred.userChoice;
            setDeferred(null);
            if (outcome === "accepted") setChoice("none");
          }}
        >
          Install app
        </button>
      ) : (
        <a className="install-go" href="/app#iphone">
          Install on iPhone
        </a>
      )}
      <button type="button" className="install-x" onClick={dismiss} aria-label="Not now">
        ×
      </button>
    </aside>
  );
}
