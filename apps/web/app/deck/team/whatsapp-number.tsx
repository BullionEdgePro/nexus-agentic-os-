"use client";

import { useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getWhatsAppNumbers,
  assignWhatsAppNumber,
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

  useEffect(() => {
    let live = true;
    setNumbers(null);
    setError(null);
    getWhatsAppNumbers(business)
      .then((data) => {
        if (live) setNumbers(data.numbers);
      })
      .catch((err) => {
        if (live) setError(readableError(err, "Could not read the account's numbers."));
      });
    return () => {
      live = false;
    };
  }, [business]);

  const current = member.whatsappPhoneNumberId ?? "";

  return (
    <div className="wn">
      <h4>Their WhatsApp number</h4>
      <p className="wn-lede">
        A dedicated number on the company account, so customers reach them on their own line. Not a
        personal WhatsApp &mdash; that cannot be connected by any tool.
      </p>

      {error ? <p className="team-msg bad">{error}</p> : null}

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
          {numbers
            .filter((n) => !n.isShared)
            .map((n) => {
              const heldByElse = n.assignedTo && n.assignedTo.id !== member.id;
              return (
                <option key={n.phoneNumberId} value={n.phoneNumberId} disabled={Boolean(heldByElse)}>
                  {n.displayPhoneNumber}
                  {n.verifiedName ? ` · ${n.verifiedName}` : ""}
                  {heldByElse ? ` (with ${n.assignedTo?.name})` : ""}
                </option>
              );
            })}
        </select>
      )}

      {numbers !== null && numbers.filter((n) => !n.isShared).length === 0 ? (
        <p className="wn-none">
          No spare numbers on the account yet. Register a dedicated number with Meta first, then it
          appears here to assign.
        </p>
      ) : null}
    </div>
  );
}
