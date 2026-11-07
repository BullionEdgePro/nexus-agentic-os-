"use client";

import { useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getPortalSettings,
  makeNewPortalFeed,
  readableError,
  saveAgentBrn,
  savePortalOrn,
  type PortalSettingsData,
} from "@/lib/api";

/**
 * Portal settings (7 Nov 2026): an admin's window from the board. The agency's
 * ORN and each agent's BRN go on every listing; the Bayut/dubizzle feed address
 * is what the agency sends Bayut to switch the feed on; Property Finder waits
 * for the agency's Enterprise API key (phase 2). Staff never see the button.
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §3, §6, §7, §8
 */

export const NEW_ADDRESS_WARNING = "The old address stops working at once. Bayut must be given the new one.";

/** "10:42, 7 Nov" in the business's own zone. */
function when(iso: string, timezone: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone })}, ${d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  })}`;
}

export function PortalSettingsButton({ isAdmin, onOpen }: { isAdmin: boolean; onOpen: () => void }) {
  if (!isAdmin) return null;
  return (
    <button type="button" className="kit-pill quiet" onClick={onOpen}>
      Portal settings
    </button>
  );
}

const digits = (s: string) => s.replace(/\D/g, "").slice(0, 10);

export function PortalSettingsView({
  settings,
  timezone,
  message,
  onSaveOrn,
  onNewAddress,
  onCopy,
  onSaveBrn,
}: {
  settings: PortalSettingsData;
  timezone: string;
  message: string;
  onSaveOrn: (orn: string | null) => void;
  onNewAddress: () => void;
  onCopy: (url: string) => void;
  onSaveBrn: (employeeId: string, brn: string | null) => void;
}) {
  const [orn, setOrn] = useState(settings.orn ?? "");
  const [brns, setBrns] = useState<Record<string, string>>(() => Object.fromEntries(settings.agents.map((a) => [a.id, a.brn ?? ""])));
  return (
    <div className="wf-window wf-board-detail">
      <p className="wf-window-tag">Portals</p>
      <h2>Portal settings</h2>
      {message ? (
        <p className="wf-board-status" role="status">
          {message}
        </p>
      ) : null}

      <section className="wf-window-part wf-board-fields">
        <h3>Agency ORN</h3>
        <div className="wf-board-field">
          <label htmlFor="portal-orn">Agency ORN</label>
          <input
            id="portal-orn"
            inputMode="numeric"
            value={orn}
            onChange={(e) => setOrn(digits(e.target.value))}
            onBlur={() => {
              if (orn !== (settings.orn ?? "")) onSaveOrn(orn || null);
            }}
          />
        </div>
        <p className="wf-board-empty">Your RERA office registration number. Every listing carries it.</p>
      </section>

      <section className="wf-window-part">
        <h3>Bayut and dubizzle feed</h3>
        {settings.feedUrl ? (
          <>
            <p className="wf-board-feed">
              <code>{settings.feedUrl}</code>
            </p>
            <div className="wf-board-move-row">
              <button type="button" className="kit-pill" onClick={() => onCopy(settings.feedUrl!)}>
                Copy
              </button>
              <button
                type="button"
                className="kit-pill quiet"
                onClick={() => {
                  if (window.confirm(NEW_ADDRESS_WARNING)) onNewAddress();
                }}
              >
                New address
              </button>
            </div>
            <p className="wf-board-empty">
              {settings.lastReadAt ? `Last read ${when(settings.lastReadAt, timezone)}${settings.lastReadBy ? ` by ${settings.lastReadBy}` : ""}` : "Not read yet"}
            </p>
            <p className="wf-board-empty">Send this address to Bayut (support@bayut.com) to switch the feed on. One feed serves Bayut and dubizzle.</p>
          </>
        ) : (
          <>
            <p className="wf-board-empty">No feed address yet.</p>
            <button type="button" className="kit-pill" onClick={onNewAddress}>
              Make the address
            </button>
          </>
        )}
      </section>

      <section className="wf-window-part wf-board-fields">
        <h3>Agents&apos; BRN</h3>
        {settings.agents.length === 0 ? <p className="wf-board-empty">No staff yet.</p> : null}
        {settings.agents.map((a) => (
          <div key={a.id} className="wf-board-field wf-board-brn">
            <label htmlFor={`brn-${a.id}`} dir="auto">
              {a.name}
            </label>
            <input
              id={`brn-${a.id}`}
              aria-label={`BRN for ${a.name}`}
              inputMode="numeric"
              value={brns[a.id] ?? ""}
              onChange={(e) => setBrns((now) => ({ ...now, [a.id]: digits(e.target.value) }))}
              onBlur={() => {
                const next = brns[a.id] ?? "";
                if (next !== (a.brn ?? "")) onSaveBrn(a.id, next || null);
              }}
            />
          </div>
        ))}
      </section>

      <section className="wf-window-part">
        <h3>Property Finder</h3>
        <p className="wf-board-empty">Not connected yet. It needs SFS&apos;s Enterprise API key (PF Expert → Developer Resources).</p>
      </section>
    </div>
  );
}

/** The window's loading and saving; the view above draws it. */
export function PortalSettings({ slug, timezone }: { slug: BusinessSlug; timezone: string }) {
  const [settings, setSettings] = useState<PortalSettingsData | null>(null);
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getPortalSettings(slug)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err) => {
        if (!cancelled) setMessage(readableError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  /** A fresh view after a save, so its inputs start from what was saved. */
  const show = (s: PortalSettingsData, said: string) => {
    setSettings(s);
    setGeneration((g) => g + 1);
    setMessage(said);
  };

  if (!settings) return <p className="wf-board-empty">{message || "Loading the portal settings…"}</p>;
  return (
    <PortalSettingsView
      key={generation}
      settings={settings}
      timezone={timezone}
      message={message}
      onSaveOrn={(orn) =>
        void savePortalOrn(slug, orn)
          .then((s) => show(s, orn ? "ORN saved." : "ORN cleared."))
          .catch((err) => setMessage(readableError(err)))
      }
      onNewAddress={() =>
        void makeNewPortalFeed(slug)
          .then((s) => show(s, "A new feed address is ready. Send it to Bayut."))
          .catch((err) => setMessage(readableError(err)))
      }
      onCopy={(url) =>
        void navigator.clipboard
          .writeText(url)
          .then(() => setMessage("Feed address copied."))
          .catch(() => setMessage("Copy it by hand: select the address above."))
      }
      onSaveBrn={(employeeId, brn) =>
        void saveAgentBrn(slug, employeeId, brn)
          .then(() => getPortalSettings(slug))
          .then((s) => show(s, brn ? "BRN saved." : "BRN cleared."))
          .catch((err) => setMessage(readableError(err)))
      }
    />
  );
}
