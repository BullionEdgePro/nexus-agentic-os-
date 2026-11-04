"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getPushDevices,
  readableError,
  registerPushDevice,
  removePushDevice,
  testPushDevice,
  updatePushDevice,
  type PushDevice,
  type PushMode,
} from "@/lib/api";

/**
 * Phone notifications (phone push, 4 Nov 2026; mobile plan Task 11).
 *
 * Nothing ever let a person turn alerts on, so no phone was ever told anything.
 * Staff see this in My settings, admins on Notifications. The view is plain and
 * rendered from props (the tests render it); PhoneAlerts below does the browser
 * work. No .css import here: node tests cannot load one, so the pages import
 * phone-alerts.css.
 */

type Role = "employee" | "operator";

const MODES: Record<Role, Array<[PushMode, string]>> = {
  employee: [
    ["mine", "My chats"],
    ["paused", "Paused"],
  ],
  operator: [
    ["mine", "My chats"],
    ["all", "Every new chat nobody has taken"],
    ["paused", "Paused"],
  ],
};

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function statusOf(device: PushDevice): { ok: boolean; text: string } {
  if (device.failureCount >= 5) return { ok: false, text: "This phone stopped receiving — turn alerts on again on it to fix" };
  if (device.lastSuccessAt) return { ok: true, text: `Working · last delivered ${ago(device.lastSuccessAt)}` };
  return { ok: true, text: "On — waiting for its first alert" };
}

export interface PhoneAlertsViewProps {
  role: Role;
  /** False in a browser with no web push: an iPhone Safari tab before Nexus is on the Home Screen. */
  supported: boolean;
  /** False until the server has its keys. */
  configured: boolean;
  devices: PushDevice[];
  /** The device this browser is, once it has been registered. */
  thisDeviceId: string | null;
  busy: string | null;
  note: { ok: boolean; text: string } | null;
  onTurnOn: () => void;
  onChange: (id: string, patch: { previews?: boolean; mode?: PushMode }) => void;
  onRemove: (id: string) => void;
  onTest: (id: string) => void;
}

export function PhoneAlertsView(props: PhoneAlertsViewProps) {
  const { role, supported, configured, devices, thisDeviceId, busy, note } = props;
  return (
    <section className="set-card pa" id="phone-alerts">
      <div className="set-card-head">
        <h2>Phone notifications</h2>
        <span className="set-sub">
          {role === "employee"
            ? "An alert on your phone when a customer writes in one of your chats, or a chat is handed to you."
            : "An alert when a customer writes on your own line, and — if you choose — when a new chat comes in that nobody has taken."}
        </span>
      </div>

      {!supported ? (
        <div className="pa-install">
          <p>Install Nexus to your Home Screen first, then turn notifications on here.</p>
          <ol>
            <li>Open Nexus in Safari.</li>
            <li>Tap Share, then Add to Home Screen.</li>
            <li>Open Nexus from its new icon and come back to this page.</li>
          </ol>
        </div>
      ) : !configured ? (
        <p className="set-hint">Notifications aren&apos;t enabled on this server yet.</p>
      ) : !thisDeviceId ? (
        <button type="button" className="set-btn pa-on" disabled={busy !== null} onClick={props.onTurnOn}>
          {busy === "on" ? "Turning on…" : "Turn on alerts on this phone"}
        </button>
      ) : null}

      {devices.length ? (
        <ul className="pa-devices">
          {devices.map((device) => {
            const status = statusOf(device);
            return (
              <li key={device.id} className="pa-device">
                <div className="pa-device-head">
                  <strong>
                    {device.label ?? "A device"}
                    {device.id === thisDeviceId ? " · this one" : ""}
                  </strong>
                  <span className={status.ok ? "pa-ok" : "pa-bad"}>{status.text}</span>
                </div>
                <label className="pa-check">
                  <input
                    type="checkbox"
                    checked={device.previews}
                    disabled={busy !== null}
                    onChange={(event) => props.onChange(device.id, { previews: event.target.checked })}
                  />{" "}
                  Show message text
                </label>
                <div className="pa-modes" role="radiogroup" aria-label="What this phone hears">
                  {MODES[role].map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={device.mode === mode}
                      className={`pa-chip ${device.mode === mode ? "on" : ""}`}
                      disabled={busy !== null}
                      onClick={() => props.onChange(device.id, { mode })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="pa-actions">
                  <button type="button" className="set-btn" disabled={busy !== null} onClick={() => props.onTest(device.id)}>
                    Send a test
                  </button>
                  <button type="button" className="set-btn pa-remove" disabled={busy !== null} onClick={() => props.onRemove(device.id)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {note ? <p className={note.ok ? "pa-ok" : "set-error"}>{note.text}</p> : null}
    </section>
  );
}

/** The VAPID public key as the bytes PushManager.subscribe wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "===".slice((base64url.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function pushSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
}

/** The panel, with the browser work: permission, subscribing, and the API. */
export function PhoneAlerts({ role }: { role: Role }) {
  const [supported, setSupported] = useState(true);
  const [state, setState] = useState<{ configured: boolean; publicKey: string | null; devices: PushDevice[] } | null>(null);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const fresh = await getPushDevices();
    setState(fresh);
    // Already subscribed in this browser: register it again (an upsert by its
    // address) to learn which listed device this one is, and to refresh its keys.
    if (pushSupported() && fresh.configured && Notification.permission === "granted") {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        const { device } = await registerPushDevice(existing.toJSON());
        setThisDeviceId(device.id);
        setState(await getPushDevices());
      }
    }
  }, []);

  useEffect(() => {
    setSupported(pushSupported());
    load().catch((err) => setNote({ ok: false, text: readableError(err, "Could not read your phone alerts.") }));
  }, [load]);

  async function turnOn() {
    setNote(null);
    // Asked first, inside the tap: iPhone only lets a page ask while the person is tapping.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNote({ ok: false, text: "Alerts are blocked for Nexus on this phone. Allow notifications for Nexus in your phone's settings, then try again." });
      return;
    }
    setBusy("on");
    try {
      if (!state?.publicKey) throw new Error("This server has no key for alerts yet.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(state.publicKey),
      });
      const { device } = await registerPushDevice(subscription.toJSON());
      setThisDeviceId(device.id);
      setState(await getPushDevices());
      setNote({ ok: true, text: "Alerts are on for this phone. Send a test to see one arrive." });
    } catch (err) {
      setNote({ ok: false, text: readableError(err, "Alerts could not be turned on. Try again in a minute.") });
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, work: () => Promise<void>) {
    setBusy(id);
    setNote(null);
    try {
      await work();
      setState(await getPushDevices());
    } catch (err) {
      setNote({ ok: false, text: readableError(err, "That did not work. Try again in a minute.") });
    } finally {
      setBusy(null);
    }
  }

  if (!state) {
    return (
      <section className="set-card pa" id="phone-alerts">
        <div className="set-card-head">
          <h2>Phone notifications</h2>
        </div>
        {note ? <p className="set-error">{note.text}</p> : <p className="set-hint">Loading…</p>}
      </section>
    );
  }

  return (
    <PhoneAlertsView
      role={role}
      supported={supported}
      configured={state.configured}
      devices={state.devices}
      thisDeviceId={thisDeviceId}
      busy={busy}
      note={note}
      onTurnOn={() => void turnOn()}
      onChange={(id, patch) => void act(id, async () => void (await updatePushDevice(id, patch)))}
      onRemove={(id) =>
        void act(id, async () => {
          await removePushDevice(id);
          // This browser's own subscription goes too, or it would keep a push
          // address nothing on the server knows about.
          if (id === thisDeviceId && pushSupported()) {
            const registration = await navigator.serviceWorker.ready;
            await (await registration.pushManager.getSubscription())?.unsubscribe();
            setThisDeviceId(null);
          }
        })
      }
      onTest={(id) =>
        void act(id, async () => {
          const { outcome } = await testPushDevice(id);
          setNote(
            outcome === "ok"
              ? { ok: true, text: "Sent — it should arrive in a few seconds." }
              : outcome === "gone"
                ? { ok: false, text: "That phone no longer accepts alerts. Remove it, then turn alerts on again on it." }
                : { ok: false, text: "The alert could not be sent just now. Try again in a minute." }
          );
        })
      }
    />
  );
}
