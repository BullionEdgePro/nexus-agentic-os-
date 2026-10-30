"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { connectStaffWhatsApp, getWhatsAppSetup, readableError, setMainBusiness, type WhatsAppSetup } from "@/lib/api";
import { launchWhatsAppSignup } from "@/lib/whatsapp-signup";

/**
 * Every staff member's WhatsApp, and whose card pays for it (30 Oct 2026).
 *
 * The owner wants one card to pay for every staff member's campaigns. A card
 * pays only for WhatsApp accounts inside its own Meta business, and each staff
 * member picks a business when they connect — Keshav Arora's number landed in
 * his own and could send nothing. So this lists everyone: connected or not,
 * which business they bill to, whether WhatsApp lets them send, whether their
 * past chats came in, and marks anyone outside the main business with the fix.
 */
export function WhatsAppSetupPanel({ business }: { business: BusinessSlug }) {
  const [setup, setSetup] = useState<WhatsAppSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mainId, setMainId] = useState("");
  const [mainName, setMainName] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectNote, setConnectNote] = useState<{ employeeId: string; ok: boolean; text: string } | null>(null);

  /**
   * Connect someone's WhatsApp Business app number for them (30 Oct 2026): the
   * owner runs Meta's window here, the person scans the QR code on their phone,
   * and the number is filed under them — no signing in as them.
   */
  async function connectFor(person: WhatsAppSetup["people"][number]) {
    if (!setup) return;
    setConnecting(person.employeeId);
    setConnectNote(null);
    try {
      const signup = await launchWhatsAppSignup(setup.signup);
      const result = await connectStaffWhatsApp(business, person.employeeId, signup);
      setConnectNote({
        employeeId: person.employeeId,
        ok: !result.businessWarning,
        text: result.businessWarning ?? `Connected ${result.number} for ${person.fullName}. Their past chats are asked for now.`,
      });
      await load();
    } catch (err) {
      setConnectNote({ employeeId: person.employeeId, ok: false, text: readableError(err, "The WhatsApp connection did not finish.") });
    } finally {
      setConnecting(null);
    }
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await getWhatsAppSetup(business);
      setSetup(data);
      setMainId(data.main?.id ?? data.suggestedBusinessId ?? "");
      setMainName(data.main?.name ?? "");
    } catch (err) {
      setError(readableError(err, "Could not read the WhatsApp setup."));
    }
  }, [business]);

  useEffect(() => {
    setSetup(null);
    void load();
  }, [load]);

  if (error) return <p className="team-empty">{error}</p>;
  if (!setup) return <p className="team-empty">Checking each person&rsquo;s WhatsApp with Meta…</p>;

  const ready = setup.people.filter((p) => p.connected && p.canSend !== "BLOCKED" && !p.paymentRefusedAt && p.onMainBusiness !== false);
  const showForm = editing || !setup.main;

  return (
    <section className="ws" aria-label="WhatsApp setup">
      <div className="ws-head">
        <h3>WhatsApp setup — one card for everyone</h3>
        <span className={ready.length === setup.people.length ? "ws-all" : ""}>
          {ready.length} of {setup.people.length} ready to send
        </span>
      </div>

      {showForm ? (
        <div className="ws-main-form">
          <p>
            Which Meta business holds your card? Every staff number must sit in it for that card to pay. Staff are told to
            choose it when they connect.
          </p>
          <label>
            <span>Business ID</span>
            <select value={mainId} onChange={(e) => setMainId(e.target.value)}>
              {setup.businesses.length === 0 ? <option value="">No connected number yet</option> : null}
              {setup.businesses.map((id) => (
                <option key={id} value={id}>
                  {id}
                  {id === setup.suggestedBusinessId ? " (most numbers are here)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Its name, as Meta shows it</span>
            <input value={mainName} maxLength={120} placeholder="sfsintlrealestate786" onChange={(e) => setMainName(e.target.value)} />
          </label>
          <div className="ws-actions">
            <button
              type="button"
              className="team-remove alt"
              disabled={saving || !mainId || !mainName.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  await setMainBusiness(business, mainId, mainName.trim());
                  setEditing(false);
                  await load();
                } catch (err) {
                  setError(readableError(err));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : "Make this the main business"}
            </button>
            {setup.main ? (
              <button type="button" className="team-remove" onClick={() => setEditing(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="ws-main">
          Main business: <strong>{setup.main?.name}</strong> <em>({setup.main?.id})</em>{" "}
          <button type="button" className="ws-link" onClick={() => setEditing(true)}>
            Change
          </button>
        </p>
      )}

      <ul className="ws-list">
        {setup.people.map((person) => {
          const steps: Array<{ ok: boolean | null; text: string }> = [
            { ok: person.connected, text: person.connected ? `Number ${person.number ?? "connected"}` : "No WhatsApp number connected" },
            {
              ok: person.connected ? person.onMainBusiness : null,
              text: !person.connected
                ? "Business: —"
                : person.onMainBusiness === false
                  ? `Bills to another business (${person.businessId ?? "unknown"})`
                  : person.onMainBusiness
                    ? "Bills to the main business"
                    : `Business ${person.businessId ?? "unknown"}`,
            },
            {
              ok: person.connected ? person.canSend !== "BLOCKED" && !person.paymentRefusedAt : null,
              text: !person.connected
                ? "Can send: —"
                : person.canSend === "BLOCKED"
                  ? `Blocked: ${person.problem ?? "WhatsApp will not send"}`
                  : person.paymentRefusedAt
                    ? "Last message refused over payment"
                    : "WhatsApp lets it send",
            },
            {
              ok: person.history ? person.history.state === "done" || person.history.state === "importing" : null,
              text: person.history
                ? person.history.state === "done"
                  ? `Past chats imported (${person.history.imported})`
                  : person.history.state === "importing"
                    ? "Importing past chats…"
                    : "Past chats not imported"
                : "Past chats not imported",
            },
          ];
          const first = person.fullName.split(" ")[0];
          const fix = !person.connected
            ? setup.signup?.configured
              ? `Press Connect WhatsApp with ${first}'s phone at hand: Meta shows a QR code to scan in WhatsApp Business${
                  setup.main ? `. Choose “${setup.main.name}” as the business` : ""
                }. Or ${first} connects it in Connections.`
              : `${first} connects their WhatsApp Business number in Connections${
                  setup.main ? ` and chooses “${setup.main.name}”` : ""
                }.`
            : person.onMainBusiness === false
              ? `Disconnect in the WhatsApp Business app, then connect again in Nexus and choose “${setup.main?.name}”. Add them as a person in that Meta business first.`
              : person.canSend === "BLOCKED" || person.paymentRefusedAt
                ? "Add a working card to the business this number bills to (Meta → Billing & payments)."
                : null;
          return (
            <li key={person.employeeId}>
              <div className="ws-person">
                <strong>{person.fullName}</strong>
                {person.jobTitle ? <em>{person.jobTitle}</em> : null}
              </div>
              <ul className="ws-steps">
                {steps.map((step) => (
                  <li key={step.text} className={step.ok === true ? "ok" : step.ok === false ? "no" : "unknown"}>
                    {step.text}
                  </li>
                ))}
              </ul>
              {fix ? <p className="ws-fix">{fix}</p> : null}
              {!person.connected && setup.signup?.configured ? (
                <button
                  type="button"
                  className="team-remove alt ws-connect"
                  disabled={connecting !== null}
                  onClick={() => void connectFor(person)}
                >
                  {connecting === person.employeeId ? "Waiting for Meta…" : "Connect WhatsApp"}
                </button>
              ) : null}
              {connectNote?.employeeId === person.employeeId ? (
                <p className={connectNote.ok ? "ws-connected" : "ws-fix"}>{connectNote.text}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
