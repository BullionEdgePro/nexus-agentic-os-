"use client";

import { ConnectionsPanel } from "../my-clients/connections";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../my-clients/my-clients.css";

/**
 * A staff member's own channels, in one place.
 *
 * The connect cards used to sit inside "My clients", below the referral link —
 * findable only by someone already there for something else. Connecting your
 * mailbox, your WhatsApp Business number, your Facebook Page and your Instagram
 * is its own recurring task ("is my Instagram still connected?"), so it gets its
 * own door. The panel itself is unchanged: each card says what the channel does,
 * what it cannot, and shows the connected account once it is wired up.
 */
export default function ConnectionsPage() {
  return (
    <div className={`deck-root ${fontVariables}`}>
      <header className="mc-head">
        <h1>Connections</h1>
        <p>
          Your own channels &mdash; email, WhatsApp Business, Facebook and Instagram. Connect each
          one here, and answer them all in the same inbox as your WhatsApp chats.
        </p>
      </header>

      <ConnectionsPanel />
    </div>
  );
}
