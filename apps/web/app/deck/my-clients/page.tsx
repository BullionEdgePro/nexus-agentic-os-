"use client";

import { useCallback, useEffect, useState } from "react";
import {
  addMyClient,
  getMyChannel,
  getMyClients,
  readableError,
  releaseMyClient,
  type MyChannel,
  type MyClient,
} from "@/lib/api";
import { MyLinkPanel } from "./my-link";
import { ConnectionsPanel } from "./connections";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "./my-clients.css";

/**
 * A staff member's own client book, and the number their messages leave from.
 *
 * ============================================================
 * THE HONEST VERSION OF "CONNECT YOUR WHATSAPP"
 * ============================================================
 *
 * The ask behind this screen was for staff to connect their own WhatsApp and
 * work their own clients from it. Two thirds of that is ordinary and is here.
 * The remaining third has an edge worth showing rather than hiding:
 *
 *   A personal WhatsApp account cannot be connected to anything. The consumer
 *   app has no API. Every library that claims to connect one is driving a
 *   logged-in web session against WhatsApp's terms, and the ban that follows
 *   lands on the business — this platform runs six businesses off one
 *   GREEN-rated number.
 *
 * So the channel panel says which number a person's messages actually go out
 * from, in those words. A staff member on the shared company number is told so
 * plainly; the alternative is a blank space that reads as a private line
 * somebody merely forgot to set up, and a campaign sent in that belief.
 */
export default function MyClientsPage() {
  const [clients, setClients] = useState<MyClient[] | null>(null);
  const [channel, setChannel] = useState<MyChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notAStaffMember, setNotAStaffMember] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (term: string) => {
    try {
      const [book, line] = await Promise.all([getMyClients(term), getMyChannel()]);
      setClients(book.clients);
      setChannel(line);
      setError(null);
      setNotAStaffMember(null);
    } catch (err) {
      // The owner reaching this screen is not an error to apologise for — they
      // genuinely have no desk, because they are not one of their own staff.
      // Said once, as a fact, instead of as a failed request.
      const message = readableError(err, "The console could not be reached.");
      if (/not one of the staff|owner/i.test(message)) setNotAStaffMember(message);
      else setError(message);
      setClients([]);
    }
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  // Debounced so a search does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(search), 250);
    return () => clearTimeout(timer);
  }, [search, load]);

  if (notAStaffMember) {
    return (
      <div className={`deck-root ${fontVariables}`}>
        <header className="mc-head">
          <h1>My clients</h1>
        </header>
        <p className="mc-empty">{notAStaffMember}</p>
      </div>
    );
  }

  return (
    <div className={`deck-root ${fontVariables}`}>
      <header className="mc-head">
        <h1>My clients</h1>
        <p>
          People who are yours rather than the business&rsquo;s. Colleagues cannot see this list;
          the owner can.
        </p>
      </header>

      <MyLinkPanel />

      {/* Directly under the link, because that is the relationship: the link
          lives in the TikTok bio, and this is whether the bio is reaching
          anybody. Apart, they are two facts; together they are a ratio. */}
      <ConnectionsPanel />

      <ChannelPanel channel={channel} />

      <section className="mc-book">
        <div className="mc-toolbar">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your clients by name or number"
            aria-label="Search your clients"
          />
          <button type="button" onClick={() => setAdding((open) => !open)}>
            {adding ? "Cancel" : "Add a client"}
          </button>
        </div>

        {adding ? (
          <AddClientForm
            onDone={() => {
              setAdding(false);
              void load(search);
            }}
          />
        ) : null}

        {error ? <p className="mc-error">{error}</p> : null}

        {clients === null ? (
          <p className="mc-empty">Loading your book&hellip;</p>
        ) : clients.length === 0 ? (
          <p className="mc-empty">
            {search
              ? "Nobody in your book matches that."
              : "Nobody yet. Add the people you already work with — they stay yours, and you can message them from here."}
          </p>
        ) : (
          <table className="mc-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">WhatsApp</th>
                <th scope="col">Company</th>
                <th scope="col">Last heard from</th>
                <th scope="col">
                  <span className="mc-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id}>
                  <td>
                    {client.displayName ?? "—"}
                    {client.optedOut ? <span className="mc-flag">opted out</span> : null}
                  </td>
                  <td className="mc-num">+{client.waId}</td>
                  <td>{client.company ?? "—"}</td>
                  <td>
                    {/* "Added, never written in" is a different fact from "went
                        quiet", and a campaign to the first is a colder message
                        than the sender usually realises. */}
                    {client.hasSpoken
                      ? new Date(client.lastMessageAt as string).toLocaleDateString()
                      : "never written in"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mc-release"
                      onClick={async () => {
                        await releaseMyClient(client.id).catch(() => undefined);
                        void load(search);
                      }}
                    >
                      Hand back
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** Which number this person's messages actually leave from. */
function ChannelPanel({ channel }: { channel: MyChannel | null }) {
  if (!channel) return null;

  const allowance = channel.allowance;

  return (
    <section className={`mc-channel mc-channel-${channel.state}`}>
      <h2>Your WhatsApp</h2>

      {channel.state === "own-number" && channel.ownNumber ? (
        <p>
          <strong>{channel.ownNumber.displayNumber}</strong> is yours. Messages you send leave from
          it, and anyone writing to it reaches you.
          {channel.ownNumber.quality && channel.ownNumber.quality !== "GREEN" ? (
            <span className="mc-warn">
              {" "}
              WhatsApp currently rates this number {channel.ownNumber.quality}, which means it is
              being rate-limited. Campaigns from it will be slow or refused.
            </span>
          ) : null}
        </p>
      ) : channel.state === "claimed-but-not-on-the-account" ? (
        <p className="mc-warn">
          A number is recorded against your account, but WhatsApp does not hold it on this business.
          Nothing will send from it. Ask the owner to add it in Meta Business Manager, or use the
          shared number until they have.
        </p>
      ) : (
        <p>
          You send from the company&rsquo;s shared number
          {channel.sharedNumber ? <strong> {channel.sharedNumber.displayNumber}</strong> : null} —
          the same one every business here uses. Your clients see the company, not you.
        </p>
      )}

      {/* Stated on every variant, because it is the question this panel exists
          to stop being answered wrongly. */}
      {channel.personalNumberOnFile ? (
        <p className="mc-note">
          Your personal mobile ({channel.personalNumberOnFile}) is on file so colleagues can reach
          you. It is not connected to this system and cannot be — the WhatsApp on your phone has no
          way to be read by software. A second business number has to be added to the company
          account in Meta Business Manager before it can appear here.
        </p>
      ) : null}

      <p className="mc-allowance">
        {channel.canBroadcast ? (
          <>
            Campaigns: <strong>{allowance.remaining}</strong> of {allowance.cap} recipients left this
            month.
          </>
        ) : (
          <>
            You cannot send campaigns yet. The owner turns this on per person, because a bulk send
            spends the shared number&rsquo;s standing with WhatsApp — which every business here
            depends on.
          </>
        )}
      </p>

      {channel.lookupFailed ? (
        <p className="mc-note">
          WhatsApp could not be reached just now, so this may be out of date. Nothing has changed.
        </p>
      ) : null}
    </section>
  );
}

function AddClientForm({ onDone }: { onDone: () => void }) {
  const [waId, setWaId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="mc-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
          await addMyClient({ waId, displayName, company, note, email });
          onDone();
        } catch (err) {
          // The three collision refusals each name a different next action.
          // Shown verbatim rather than flattened, because "already exists"
          // would make a colleague's client look like a typo.
          setError(readableError(err, "Could not save them."));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        <span>WhatsApp number</span>
        <input
          value={waId}
          onChange={(event) => setWaId(event.target.value)}
          placeholder="971501234567"
          inputMode="tel"
          required
        />
        <em>Country code, digits only.</em>
      </label>
      <label>
        <span>Name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
        />
      </label>
      <label>
        <span>Company</span>
        <input value={company} onChange={(event) => setCompany(event.target.value)} />
      </label>
      <label>
        <span>Email</span>
        <input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          inputMode="email"
          placeholder="optional"
        />
        {/* The only thing a connected mailbox is ever searched for. Without an
            address here there is nothing to look up, and the Gmail panel says
            so rather than showing an empty list that reads as "no mail". */}
        <em>Used to find their emails if you connect Gmail.</em>
      </label>
      <label className="mc-wide">
        <span>Note</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
      </label>
      {error ? <p className="mc-error mc-wide">{error}</p> : null}
      <button type="submit" disabled={saving} className="mc-wide">
        {saving ? "Saving…" : "Add to my book"}
      </button>
    </form>
  );
}
