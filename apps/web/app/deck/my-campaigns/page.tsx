"use client";

import Link from "next/link";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../my-clients/my-clients.css";
import "./my-campaigns.css";

/**
 * My campaigns, retired for staff (30 Oct 2026).
 *
 * The owner moved all bulk messaging to the two admin accounts: they choose the
 * number and the customers on Bulk messaging, and staff chat one to one. The
 * staff campaign API refuses every send (routes/my-campaigns.ts), so this page
 * says where things went to anyone who follows an old link, rather than
 * showing buttons that can only fail.
 */
export default function MyCampaignsPage() {
  return (
    <div className={`deck-root ${fontVariables}`}>
      <header className="mc-head">
        <h1>My campaigns</h1>
        <p>Bulk messaging is done by the admins now.</p>
      </header>
      <section className="cmp-compose">
        <p className="cmp-facts">
          To message your clients, open their conversation in the{" "}
          <Link href="/inbox">inbox</Link> and reply there. If a message should go to many clients at once, ask an admin —
          they send it from Bulk messaging.
        </p>
        <p className="cmp-facts">
          Your clients are still in <Link href="/deck/my-clients">My clients</Link>.
        </p>
      </section>
    </div>
  );
}
