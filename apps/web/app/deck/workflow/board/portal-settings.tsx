"use client";

import { useEffect, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  checkPfKey,
  disconnectPf,
  getPortalSettings,
  makeNewPortalFeed,
  readableError,
  saveAgentBrn,
  savePfKey,
  savePortalOrn,
  type PfEnvironment,
  type PortalSettingsData,
} from "@/lib/api";

/**
 * Portal settings (7 Nov 2026): an admin's window from the board. The agency's
 * ORN and each agent's BRN go on every listing; the Bayut/dubizzle feed address
 * is what the agency sends Bayut to switch the feed on; Property Finder takes
 * the agency's API key and secret, checked and kept sealed (its connection,
 * 7 Nov 2026). Staff never see the button.
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

export type SettingsDrafts = { orn: string; brns: Record<string, string> };
export type PendingSave = { kind: "orn"; value: string | null } | { kind: "brn"; id: string; value: string | null };

/**
 * What the window holds that is not saved yet (final review): saved on close,
 * so an ORN or BRN typed and then closed with Escape — which unmounts the field
 * without a blur — is not lost. Only agents the window lists are ever saved.
 */
export function pendingSaves(drafts: SettingsDrafts, settings: PortalSettingsData): PendingSave[] {
  const saves: PendingSave[] = [];
  if (drafts.orn !== (settings.orn ?? "")) saves.push({ kind: "orn", value: drafts.orn || null });
  for (const agent of settings.agents) {
    const draft = drafts.brns[agent.id];
    if (draft !== undefined && draft !== (agent.brn ?? "")) saves.push({ kind: "brn", id: agent.id, value: draft || null });
  }
  return saves;
}

export const PF_DISCONNECT_WARNING = "Nexus stops updating Property Finder. Listings already there stay until removed in PF Expert.";
const PF_STEPS = "A Decision Maker opens PF Expert → Developer Resources → API Credentials → New API Key. Start with a Sandbox.";
export type PfKeyInput = { apiKey: string; apiSecret: string; environment: PfEnvironment };

/**
 * Property Finder's key (7 Nov 2026). The admin pastes the key and secret the
 * Decision Maker made; Nexus checks them and keeps them sealed — this section
 * only ever shows the key's last four characters and what the check said. The
 * fields are emptied as soon as they are sent.
 * Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §6
 */
export function PfSection({
  pf,
  timezone,
  onSaveKey,
  onCheck,
  onDisconnect,
}: {
  pf: PortalSettingsData["propertyFinder"];
  timezone: string;
  onSaveKey: (input: PfKeyInput) => void;
  onCheck: () => void;
  onDisconnect: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [environment, setEnvironment] = useState<PfEnvironment>(pf.environment ?? "sandbox");
  const status = pf.checkError
    ? pf.checkError
    : `Connected (${pf.environment === "live" ? "Live" : "Sandbox"}) — key ending ${pf.keyEnding ?? "····"}${
        pf.checkedAt ? `, checked ${when(pf.checkedAt, timezone)}` : ""
      }`;
  return (
    <section className="wf-window-part">
      <h3>Property Finder</h3>
      {pf.saved ? (
        <p className={pf.checkError ? "wf-board-portal-warn" : "wf-board-status"}>{status}</p>
      ) : (
        <p className="wf-board-empty">{PF_STEPS}</p>
      )}
      {pf.saved && !pf.listingCallsReady ? (
        <p className="wf-board-empty">Listings start going to Property Finder once its listing format is added to Nexus.</p>
      ) : null}
      {!pf.saved || replacing ? (
        <form
          className="wf-board-fields"
          onSubmit={(e) => {
            e.preventDefault();
            onSaveKey({ apiKey, apiSecret, environment });
            setApiKey("");
            setApiSecret("");
            setReplacing(false);
          }}
        >
          <div className="wf-board-field">
            <label htmlFor="pf-key">API key</label>
            <input id="pf-key" aria-label="API key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="wf-board-field">
            <label htmlFor="pf-secret">API secret</label>
            <input
              id="pf-secret"
              type="password"
              aria-label="API secret"
              autoComplete="off"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
            />
          </div>
          <div className="wf-board-field">
            <label htmlFor="pf-environment">Account</label>
            <select id="pf-environment" value={environment} onChange={(e) => setEnvironment(e.target.value as PfEnvironment)}>
              <option value="sandbox">Sandbox</option>
              <option value="live">Live</option>
            </select>
          </div>
          <div className="wf-board-move-row">
            <button type="submit" className="kit-pill">
              Save and check
            </button>
            {replacing ? (
              <button type="button" className="kit-pill quiet" onClick={() => setReplacing(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="wf-board-move-row">
          <button type="button" className="kit-pill" onClick={onCheck}>
            Check again
          </button>
          <button type="button" className="kit-pill quiet" onClick={() => setReplacing(true)}>
            Replace key
          </button>
          <button
            type="button"
            className="kit-pill quiet"
            onClick={() => {
              if (window.confirm(PF_DISCONNECT_WARNING)) onDisconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}

export function PortalSettingsView({
  settings,
  timezone,
  message,
  onSaveOrn,
  onNewAddress,
  onCopy,
  onSaveBrn,
  onSavePfKey,
  onCheckPf,
  onDisconnectPf,
}: {
  settings: PortalSettingsData;
  timezone: string;
  message: string;
  onSaveOrn: (orn: string | null) => void;
  onNewAddress: () => void;
  onCopy: (url: string) => void;
  onSaveBrn: (employeeId: string, brn: string | null) => void;
  onSavePfKey: (input: PfKeyInput) => void;
  onCheckPf: () => void;
  onDisconnectPf: () => void;
}) {
  const [orn, setOrn] = useState(settings.orn ?? "");
  const [brns, setBrns] = useState<Record<string, string>>(() => Object.fromEntries(settings.agents.map((a) => [a.id, a.brn ?? ""])));
  // A save answers with the new settings without remounting this view, so what
  // is being typed in another field stays; anything unsaved is saved on close.
  const latest = useRef({ drafts: { orn, brns } as SettingsDrafts, settings, onSaveOrn, onSaveBrn });
  latest.current = { drafts: { orn, brns }, settings, onSaveOrn, onSaveBrn };
  useEffect(
    () => () => {
      const { drafts, settings: saved, onSaveOrn: saveOrn, onSaveBrn: saveBrn } = latest.current;
      for (const save of pendingSaves(drafts, saved)) {
        if (save.kind === "orn") saveOrn(save.value);
        else saveBrn(save.id, save.value);
      }
    },
    []
  );
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
          <input
            id="portal-orn"
            aria-label="Agency ORN"
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

      <PfSection pf={settings.propertyFinder} timezone={timezone} onSaveKey={onSavePfKey} onCheck={onCheckPf} onDisconnect={onDisconnectPf} />
    </div>
  );
}

/** The window's loading and saving; the view above draws it. */
export function PortalSettings({ slug, timezone }: { slug: BusinessSlug; timezone: string }) {
  const [settings, setSettings] = useState<PortalSettingsData | null>(null);
  const [message, setMessage] = useState("");

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

  /** The saved settings become the view's baseline; its drafts are left as they are. */
  const show = (s: PortalSettingsData, said: string) => {
    setSettings(s);
    setMessage(said);
  };

  if (!settings) return <p className="wf-board-empty">{message || "Loading the portal settings…"}</p>;
  return (
    <PortalSettingsView
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
      onSavePfKey={(input) => {
        setMessage("Checking the key with Property Finder…");
        void savePfKey(slug, input)
          .then((s) => show(s, s.propertyFinder.checkError ? "Key saved, but Property Finder did not accept it." : "Key saved — Property Finder accepted it."))
          .catch((err) => setMessage(readableError(err)));
      }}
      onCheckPf={() =>
        void checkPfKey(slug)
          .then((s) => show(s, s.propertyFinder.checkError ? "Property Finder still does not accept the key." : "Property Finder accepts the key."))
          .catch((err) => setMessage(readableError(err)))
      }
      onDisconnectPf={() =>
        void disconnectPf(slug)
          .then((s) => show(s, "Property Finder disconnected."))
          .catch((err) => setMessage(readableError(err)))
      }
    />
  );
}
