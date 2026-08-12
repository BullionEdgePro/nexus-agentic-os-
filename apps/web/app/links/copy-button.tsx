"use client";

import { useState } from "react";

/**
 * The only interactive thing on the page, and therefore the only client
 * component. Everything else — including the QR codes — is rendered on the
 * server, so the page still reads correctly with JavaScript blocked, which is
 * a real state for a printed page opened on a locked-down office machine.
 */
export function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Cleared rather than left showing: a permanent "Copied" gives no signal
      // the second time somebody presses it.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard API is refused on an insecure origin and in some embedded
      // browsers. Saying so beats a button that silently does nothing — the URL
      // is on screen and can be selected by hand.
      setFailed(true);
    }
  }

  return (
    <button className={`pl-copy${copied ? " done" : ""}`} onClick={copy} type="button">
      {failed ? "Select the link above" : copied ? "Copied" : "Copy link"}
    </button>
  );
}
