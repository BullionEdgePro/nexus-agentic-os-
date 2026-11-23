"use client";

import { useEffect, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  checkBayutToken,
  checkPfKey,
  disconnectPf,
  getPortalSettings,
  linkBayutAgent,
  readableError,
  removeBayutToken,
  saveAgentBrn,
  saveBayutToken,
  savePfKey,
  savePortalOrn,
  type BayutCheckAnswer,
  type BayutSettings,
  type PfEnvironment,
  type PortalSettingsData,
} from "@/lib/api";

/**
 * Portal settings (7 Nov 2026): an admin's window from the board. The agency's
 * ORN and each agent's BRN go on every listing; Property Finder takes the
 * agency's API key and secret, checked and kept sealed (its connection,
 * 7 Nov 2026). Staff never see the button.
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §3, §6, §7, §8
 *
 * Bayut and dubizzle (23 Nov 2026): the business's Bayut API token, checked
 * and kept sealed like Property Finder's, and each agent's Bayut user, replace
 * the feed address — the XML feed is left in code, hidden from screens.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §11
 */

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
              // Not a login: "off" is ignored on password fields, and the browser would offer to
              // save the secret as the Nexus password and fill it into the sign-in page (final review).
              autoComplete="new-password"
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

export const BAYUT_STEPS = "Sign in to Profolio → use the API token Bayut emailed you, or copy it from the Profolio dashboard. Start with the Sandbox token.";
export const BAYUT_CREDITS_NOTE = "Publishing uses Bayut credits. Boosts (Hot, Signature) are bought in Profolio.";
export const BAYUT_DISCONNECT_WARNING = "Nexus stops updating Bayut and dubizzle. Listings already on Bayut stay until removed in Profolio.";
/** Said once the server has turned the switches off, when the token is another Bayut account's (worded as done, final review M5). */
export const BAYUT_ACCOUNT_CHANGED =
  "This token belongs to a different Bayut account. Every Bayut and dubizzle switch has been turned off. Listings already on the old account stay there until removed in Profolio.";

/** What the window says after Save and check. */
export function bayutSavedMessage(answer: BayutCheckAnswer): string {
  if (answer.accountChanged) return BAYUT_ACCOUNT_CHANGED;
  return answer.bayut.checkError ? "Token saved, but the check did not pass." : "Token saved — Bayut accepted it.";
}

/** What the window says after Check again: a token whose first check failed may turn out to be another account's. */
export function bayutCheckedMessage(answer: BayutCheckAnswer): string {
  if (answer.accountChanged) return BAYUT_ACCOUNT_CHANGED;
  return answer.bayut.checkError ? "The check did not pass." : "Bayut accepts the token.";
}

/** A Bayut user's name in the choice; a link to one the last check did not read still shows. */
function bayutUserLabel(user: BayutSettings["users"][number]): string {
  const name = user.name.trim();
  if (name && user.email) return `${name} (${user.email})`;
  return name || user.email || `Bayut user ${user.id}`;
}

/**
 * Bayut and dubizzle (23 Nov 2026). The admin pastes the API token from
 * Profolio; Nexus checks it with Bayut and keeps it sealed — this section only
 * ever shows its last four characters, the account the check read, or what
 * Bayut said instead (never "Connected" beside a failed check, whose account
 * name may be an earlier token's). The field is a password field, emptied as
 * soon as the token is sent. Once saved, each staff member is linked to one of
 * the Bayut users the last check read.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §11
 */
export function BayutSection({
  bayut,
  agents,
  timezone,
  onSaveToken,
  onCheck,
  onDisconnect,
  onLinkAgent,
}: {
  bayut: BayutSettings;
  agents: PortalSettingsData["agents"];
  timezone: string;
  onSaveToken: (token: string) => void;
  onCheck: () => void;
  onDisconnect: () => void;
  onLinkAgent: (employeeId: string, bayutUserId: number | null) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState("");
  const status =
    bayut.checkError ??
    `Connected to ${bayut.agencyName ?? "Bayut"} — token ending ${bayut.tokenEnding ?? "····"}${
      bayut.checkedAt ? `, checked ${when(bayut.checkedAt, timezone)}` : ""
    }`;
  const linked = new Map(bayut.links.map((l) => [l.employeeId, l.bayutUserId]));
  return (
    <section className="wf-window-part">
      <h3>Bayut and dubizzle</h3>
      {bayut.saved ? (
        <p className={bayut.checkError ? "wf-board-portal-warn" : "wf-board-status"}>{status}</p>
      ) : (
        <p className="wf-board-empty">{BAYUT_STEPS}</p>
      )}
      {!bayut.saved || replacing ? (
        <form
          className="wf-board-fields"
          onSubmit={(e) => {
            e.preventDefault();
            onSaveToken(token);
            setToken("");
            setReplacing(false);
          }}
        >
          <div className="wf-board-field">
            <label htmlFor="bayut-token">API token</label>
            <input
              id="bayut-token"
              type="password"
              aria-label="API token"
              // Not a login: as Property Finder's secret, so the browser never offers to save it as the Nexus password.
              autoComplete="new-password"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
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
            Replace token
          </button>
          <button
            type="button"
            className="kit-pill quiet"
            onClick={() => {
              if (window.confirm(BAYUT_DISCONNECT_WARNING)) onDisconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
      {bayut.saved ? (
        <div className="wf-board-fields">
          <h4>Agents</h4>
          {agents.length === 0 ? <p className="wf-board-empty">No staff yet.</p> : null}
          {agents.map((a) => {
            const userId = linked.get(a.id);
            const known = userId === undefined || bayut.users.some((u) => u.id === userId);
            return (
              <div key={a.id} className="wf-board-field">
                <label htmlFor={`bayut-user-${a.id}`} dir="auto">
                  {a.name}
                </label>
                <select
                  id={`bayut-user-${a.id}`}
                  aria-label={`Bayut user for ${a.name}`}
                  value={userId === undefined ? "" : String(userId)}
                  onChange={(e) => onLinkAgent(a.id, e.target.value === "" ? null : Number(e.target.value))}
                >
                  <option value="">Not linked</option>
                  {known ? null : <option value={String(userId)}>{`Bayut user ${userId}`}</option>}
                  {bayut.users.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {bayutUserLabel(u)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      ) : null}
      <p className="wf-board-empty">{BAYUT_CREDITS_NOTE}</p>
    </section>
  );
}

export function PortalSettingsView({
  settings,
  timezone,
  message,
  onSaveOrn,
  onSaveBrn,
  onSavePfKey,
  onCheckPf,
  onDisconnectPf,
  onSaveBayutToken,
  onCheckBayut,
  onDisconnectBayut,
  onLinkBayutAgent,
}: {
  settings: PortalSettingsData;
  timezone: string;
  message: string;
  onSaveOrn: (orn: string | null) => void;
  onSaveBrn: (employeeId: string, brn: string | null) => void;
  onSavePfKey: (input: PfKeyInput) => void;
  onCheckPf: () => void;
  onDisconnectPf: () => void;
  onSaveBayutToken: (token: string) => void;
  onCheckBayut: () => void;
  onDisconnectBayut: () => void;
  onLinkBayutAgent: (employeeId: string, bayutUserId: number | null) => void;
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

      <BayutSection
        bayut={settings.bayut}
        agents={settings.agents}
        timezone={timezone}
        onSaveToken={onSaveBayutToken}
        onCheck={onCheckBayut}
        onDisconnect={onDisconnectBayut}
        onLinkAgent={onLinkBayutAgent}
      />

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
      onSaveBayutToken={(token) => {
        setMessage("Checking the token with Bayut…");
        void saveBayutToken(slug, token)
          .then((answer) => show(settingsOf(answer), bayutSavedMessage(answer)))
          .catch((err) => setMessage(readableError(err)));
      }}
      onCheckBayut={() => {
        setMessage("Checking the token with Bayut…");
        void checkBayutToken(slug)
          .then((answer) => show(settingsOf(answer), bayutCheckedMessage(answer)))
          .catch((err) => setMessage(readableError(err)));
      }}
      onDisconnectBayut={() =>
        void removeBayutToken(slug)
          .then((s) => show(s, "Bayut disconnected. Listings already on Bayut stay until removed in Profolio."))
          .catch((err) => setMessage(readableError(err)))
      }
      onLinkBayutAgent={(employeeId, bayutUserId) =>
        void linkBayutAgent(slug, employeeId, bayutUserId)
          .then((s) => show(s, bayutUserId === null ? "Bayut link removed." : "Bayut user linked."))
          .catch((err) => setMessage(readableError(err)))
      }
    />
  );
}

/** The settings in a save's or a check's answer, without whether the account changed. */
function settingsOf({ accountChanged: _accountChanged, ...settings }: BayutCheckAnswer): PortalSettingsData {
  return settings;
}
