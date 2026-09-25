"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getWhatsAppNumbers,
  assignWhatsAppNumber,
  addWhatsAppNumber,
  resendWhatsAppNumberCode,
  verifyWhatsAppNumber,
  readableError,
  type TeamMember,
  type WabaNumberRow,
} from "@/lib/api";

/**
 * Give a staff member their own WhatsApp number.
 *
 * ============================================================
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ============================================================
 *
 * This assigns a DEDICATED number that is already on the company's WhatsApp
 * Business Account to one person, so their customers reach them on their own
 * line and their replies go out from it. It is NOT connecting a personal
 * WhatsApp — that is impossible for any tool, and trying bans the whole account.
 * The shared company number is shown for orientation but can never be handed to
 * one person; a number already held by a colleague says so.
 *
 * It can also REGISTER a new line on the account (add it, Meta sends a code to
 * that phone, the owner types the code here) and hand it to this person in the
 * same step. That route needs no Meta Tech Provider registration — it is an
 * admin adding a line to the business's own account.
 */
export function WhatsAppNumberPicker({
  business,
  member,
  onChanged,
}: {
  business: BusinessSlug;
  member: TeamMember;
  onChanged: (member: TeamMember) => void;
}) {
  const [numbers, setNumbers] = useState<WabaNumberRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getWhatsAppNumbers(business);
      setNumbers(data.numbers);
    } catch (err) {
      setError(readableError(err, "Could not read the account's numbers."));
    }
  }, [business]);

  useEffect(() => {
    setNumbers(null);
    setError(null);
    void load();
  }, [load]);

  const current = member.whatsappPhoneNumberId ?? "";
  const spare = (numbers ?? []).filter((n) => !n.isShared);

  return (
    <div className="wn">
      <h4>Their WhatsApp number</h4>
      <p className="wn-lede">
        A dedicated number on the company account, so customers reach them on their own line. Not a
        personal WhatsApp &mdash; that cannot be connected by any tool.
      </p>

      {error ? <p className="team-msg bad">{error}</p> : null}
      {notice && !error ? <p className="team-msg ok">{notice}</p> : null}

      {numbers === null ? (
        <p className="wn-loading">Reading the account&hellip;</p>
      ) : (
        <select
          value={current}
          disabled={busy}
          onChange={async (event) => {
            const value = event.target.value || null;
            setBusy(true);
            setError(null);
            setNotice(null);
            try {
              const { employee } = await assignWhatsAppNumber(business, member.id, value);
              onChanged(employee);
            } catch (err) {
              setError(readableError(err, "That number was not assigned."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">None — sends from the shared company number</option>
          {spare.map((n) => {
            const heldByElse = n.assignedTo && n.assignedTo.id !== member.id;
            return (
              <option
                key={n.phoneNumberId}
                value={n.phoneNumberId}
                disabled={Boolean(heldByElse) || !n.ready}
              >
                {n.displayPhoneNumber}
                {n.verifiedName ? ` · ${n.verifiedName}` : ""}
                {heldByElse ? ` (with ${n.assignedTo?.name})` : ""}
                {!n.ready ? " (code not entered yet)" : ""}
              </option>
            );
          })}
        </select>
      )}

      {numbers !== null && spare.length === 0 ? (
        <p className="wn-none">No spare numbers on the account yet. Register one below.</p>
      ) : null}

      {numbers !== null ? (
        <RegisterNumber
          business={business}
          member={member}
          disabled={busy}
          onRegistered={async (employee, number) => {
            if (employee) onChanged(employee);
            setError(null);
            setNotice(`${number} is registered and now ${member.fullName}'s line.`);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Add a spare line to the account and give it to this person.
 *
 * Two steps because Meta proves ownership of the phone: it sends a 6-digit code
 * to it, and the owner types that code here. The platform never sees the phone.
 */
function RegisterNumber({
  business,
  member,
  disabled,
  onRegistered,
}: {
  business: BusinessSlug;
  member: TeamMember;
  disabled: boolean;
  onRegistered: (employee: TeamMember | undefined, number: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [countryCode, setCountryCode] = useState("971");
  const [number, setNumber] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [method, setMethod] = useState<"SMS" | "VOICE">("SMS");
  const [pending, setPending] = useState<{ phoneNumberId: string; displayPhoneNumber: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const reset = () => {
    setPending(null);
    setCode("");
    setError(null);
    setHint(null);
  };

  if (!open) {
    return (
      <button type="button" className="btn small wn-reg-open" disabled={disabled} onClick={() => setOpen(true)}>
        Register a new number for {member.fullName}
      </button>
    );
  }

  return (
    <div className="wn-reg">
      {error ? <p className="team-msg bad">{error}</p> : null}
      {hint && !error ? <p className="team-msg ok">{hint}</p> : null}

      {!pending ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const added = await addWhatsAppNumber(business, {
                countryCode,
                number,
                displayName: displayName.trim() || undefined,
                method,
              });
              setPending({ phoneNumberId: added.phoneNumberId, displayPhoneNumber: added.displayPhoneNumber });
              setHint(
                method === "SMS"
                  ? `Meta is texting a 6-digit code to ${added.displayPhoneNumber}.`
                  : `Meta is calling ${added.displayPhoneNumber} to read out a 6-digit code.`
              );
            } catch (err) {
              setError(readableError(err, "That number could not be added."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="wn-reg-note">
            Use a phone line that can receive a text or call and is <strong>not</strong> on WhatsApp or
            WhatsApp Business. A number still on either app must have its WhatsApp account deleted first.
          </p>
          <div className="wn-reg-row">
            <label className="wn-cc">
              Country code
              <input
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                inputMode="numeric"
                placeholder="971"
                required
              />
            </label>
            <label className="wn-num">
              Number
              <input
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                inputMode="tel"
                placeholder="50 123 4567"
                required
              />
            </label>
          </div>
          <label>
            Name customers see <small>(optional — defaults to the business&rsquo;s approved name)</small>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Zipicka" />
          </label>
          <div className="wn-reg-method" role="radiogroup" aria-label="How Meta sends the code">
            <label>
              <input type="radio" checked={method === "SMS"} onChange={() => setMethod("SMS")} /> Text message
            </label>
            <label>
              <input type="radio" checked={method === "VOICE"} onChange={() => setMethod("VOICE")} /> Phone call
            </label>
          </div>
          <div className="wn-reg-actions">
            <button type="submit" className="btn small" disabled={busy || !number.trim()}>
              {busy ? "Sending…" : "Send the code"}
            </button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => { reset(); setOpen(false); }}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const done = await verifyWhatsAppNumber(business, pending.phoneNumberId, code, member.id);
              const label = pending.displayPhoneNumber;
              reset();
              setOpen(false);
              await onRegistered(done.employee, label);
            } catch (err) {
              setError(readableError(err, "That code was not accepted."));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            6-digit code sent to {pending.displayPhoneNumber}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              required
            />
          </label>
          <div className="wn-reg-actions">
            <button type="submit" className="btn small" disabled={busy || code.replace(/\D/g, "").length !== 6}>
              {busy ? "Registering…" : `Register and give to ${member.fullName}`}
            </button>
            <button
              type="button"
              className="btn small ghost"
              disabled={busy}
              onClick={async () => {
                const next = method === "SMS" ? "VOICE" : "SMS";
                setBusy(true);
                setError(null);
                try {
                  await resendWhatsAppNumberCode(business, pending.phoneNumberId, next);
                  setMethod(next);
                  setHint(next === "SMS" ? "A new code is on its way by text." : "Meta will call with a new code.");
                } catch (err) {
                  setError(readableError(err, "A new code was not sent."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {method === "SMS" ? "Call me instead" : "Text me instead"}
            </button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={reset}>
              Start over
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
