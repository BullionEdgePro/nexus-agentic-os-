"use client";

import { useEffect, useState } from "react";
import { getUnheldWhatsAppNumbers, type UnheldWhatsAppNumber } from "@/lib/api";

/**
 * WhatsApp numbers reaching Nexus that nobody holds (5 Nov 2026), on an admin's
 * Connections. A connect can finish at Meta without Nexus hearing; the number is
 * then live, its customers write, and every message goes to nobody — +971 58 848
 * 3731 (SFS) lost 34 in a day that way, seen only in the server's logs.
 *
 * Quiet when there is nothing to say, and when the list cannot be read: this is
 * a warning, not a feature anybody waits on.
 */
export function UnheldNumbers() {
  const [numbers, setNumbers] = useState<UnheldWhatsAppNumber[]>([]);
  useEffect(() => {
    getUnheldWhatsAppNumbers()
      .then((answer) => setNumbers(answer.numbers))
      .catch(() => undefined);
  }, []);
  return <UnheldNumbersList numbers={numbers} />;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function UnheldNumbersList({ numbers }: { numbers: UnheldWhatsAppNumber[] }) {
  if (numbers.length === 0) return null;
  return (
    <div className="cnx-card cnx-unheld" role="alert">
      <div className="cnx-head">
        <strong>WhatsApp numbers nobody here holds</strong>
      </div>
      {numbers.map((number) => (
        <p key={number.phoneNumberId} className="cnx-unheld-line">
          <b>{number.displayNumber ?? `Number ${number.phoneNumberId}`}</b>
          {number.verifiedName ? ` · ${number.verifiedName}` : ""} — {number.messages} customer{" "}
          {number.messages === 1 ? "message" : "messages"} since {when(number.firstSeen)} reached nobody.
        </p>
      ))}
      <p className="cnx-note">
        These numbers are connected at Meta, but nobody in Nexus holds them, so their customers&apos; messages go
        nowhere. Whoever has the phone should connect WhatsApp again from their Connections (or an admin does it for
        them on Team). In Meta&apos;s window, choose Continue: the number is already set up. The chats on that phone
        are then copied in.
      </p>
    </div>
  );
}
