"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { BusinessTabs } from "@/lib/business-tabs";
import {
  getBulkNumber,
  getBulkOverview,
  getBulkTemplateText,
  getBulkTestStatus,
  readableError,
  refreshBulkTemplates,
  sendBulk,
  sendBulkQuick,
  sendBulkTest,
  type BroadcastSummary,
  type BulkNumber,
  type BulkNumberView,
  type CampaignTestStatus,
} from "@/lib/api";
import { standingOf } from "@/lib/client-filters";
import { fontVariables } from "@/lib/fonts";
import { tenantName } from "@/lib/tenants";
import { AddNumbers } from "./add-numbers";
import { AiWriter } from "./ai-writer";
import { NewApproved } from "./new-approved";
import { ClientsTab } from "../my-campaigns/clients-tab";
import { QuickMessage } from "../my-campaigns/quick-message";
import { TemplateText } from "../my-campaigns/template-text";
import "../deck.css";
import "../my-clients/my-clients.css";
import "../my-campaigns/my-campaigns.css";
// The Approved / Quick tabs are styled here (ecf-tabs). The staff page used to
// load it through EmailCampaignForm; this page never did, so the tabs ran
// together as plain text.
import "../my-campaigns/email-campaign.css";
import "./bulk.css";

/**
 * Bulk messaging — for the admins only (30 Oct 2026).
 *
 * The owner moved all bulk sending off the staff screens: staff chat one to
 * one, and the two admin accounts send in bulk. Four steps, top to bottom, in
 * the order a person decides them: the business, the number it goes out from
 * (any connected number), the customers (any of the business's, ticked), and
 * the message — an approved one with its wording shown, or a free quick
 * message to whoever wrote to that number in the last 24 hours.
 */

const STATUS_WORDS: Record<string, string> = {
  sending: "Sending",
  completed: "Finished",
  failed: "Failed",
  paused: "Paused",
  stopped: "Stopped",
  draft: "Draft",
};

export default function BulkMessagingPage() {
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [numbers, setNumbers] = useState<BulkNumber[] | null>(null);
  const [campaigns, setCampaigns] = useState<BroadcastSummary[]>([]);
  const [numberId, setNumberId] = useState("");
  const [view, setView] = useState<BulkNumberView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<"approved" | "quick">("approved");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [customersTab, setCustomersTab] = useState<"pick" | "add">("pick");
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const compose = useRef<HTMLDivElement>(null);

  const loadOverview = useCallback(async (slug: BusinessSlug) => {
    setError(null);
    try {
      const data = await getBulkOverview(slug);
      setNumbers(data.numbers);
      setCampaigns(data.campaigns);
      setNumberId((current) => (data.numbers.some((n) => n.phoneNumberId === current) ? current : data.numbers[0]?.phoneNumberId ?? ""));
    } catch (err) {
      setError(readableError(err, "Could not load bulk messaging."));
    }
  }, []);

  useEffect(() => {
    setNumbers(null);
    setView(null);
    setPicked(new Set());
    setCustomersTab("pick");
    void loadOverview(business);
  }, [business, loadOverview]);

  useEffect(() => {
    if (!numberId) return;
    let cancelled = false;
    setView(null);
    setTemplateId("");
    setJustAdded(new Set());
    getBulkNumber(business, numberId)
      .then((data) => {
        if (cancelled) return;
        setView(data);
        // Messages waiting for WhatsApp: ask once, by itself, so a decision
        // made while nobody was looking shows without pressing Check again.
        if (data.pending?.length) {
          void refreshBulkTemplates(business, numberId)
            .then((fresh) => {
              if (!cancelled) setView((current) => (current ? { ...current, pending: fresh.pending, templates: fresh.templates } : current));
            })
            .catch(() => undefined);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(readableError(err, "Could not read that number."));
      });
    return () => {
      cancelled = true;
    };
  }, [business, numberId]);

  const customers = view?.customers ?? [];
  const chosen = customers.filter((customer) => picked.has(customer.id));
  const chosenIds = chosen.map((customer) => customer.id);
  const inWindow = chosen.filter((customer) => standingOf(customer.lastInboundAt) === "free");
  const number = numbers?.find((n) => n.phoneNumberId === numberId) ?? null;
  const knownNumbers = useMemo(() => new Set((view?.customers ?? []).map((customer) => customer.waId)), [view]);
  const newNeverWrote = chosen.filter((customer) => justAdded.has(customer.id) && !customer.lastInboundAt).length;

  /** Numbers just added: reload the customers so they are listed, tick them, and point at approved messages. */
  async function onNumbersAdded(ids: string[]) {
    if (ids.length === 0) return;
    try {
      setView(await getBulkNumber(business, numberId));
    } catch (err) {
      setError(readableError(err, "Could not reload the customers."));
    }
    setPicked((current) => new Set([...current, ...ids]));
    setJustAdded(new Set(ids));
    setKind("approved");
  }

  /** After a new approved message is sent or checked: reload, and choose the one just approved. */
  async function reloadNumber(approvedTemplateId?: string) {
    try {
      setView(await getBulkNumber(business, numberId));
      if (approvedTemplateId) setTemplateId(approvedTemplateId);
    } catch (err) {
      setError(readableError(err, "Could not reload the number."));
    }
  }

  return (
    <div className={`deck-root ${fontVariables}`}>
      <header className="mc-head">
        <h1>Bulk messaging</h1>
        <p>Admins only. Choose the business, the number it goes from, the customers, then the message.</p>
      </header>

      <BusinessTabs value={business} onChange={(slug) => slug && setBusiness(slug)} includeAll={false} />

      {error ? <p className="mc-error">{error}</p> : null}

      <section className="bk-step">
        <h2>
          <span>1</span> Send from
        </h2>
        {numbers === null ? (
          <p className="mc-empty">Loading the numbers…</p>
        ) : numbers.length === 0 ? (
          <p className="mc-empty">
            This business has no connected WhatsApp number. A staff member connects theirs in Connections, or the
            business connects its own.
          </p>
        ) : (
          <>
            <select className="bk-select" value={numberId} onChange={(event) => setNumberId(event.target.value)}>
              {numbers.map((n) => (
                <option key={n.phoneNumberId} value={n.phoneNumberId}>
                  {n.label}
                </option>
              ))}
            </select>
            {view && !view.canSend ? <p className="mc-error">This number cannot send right now: {view.blocked}</p> : null}
            {view?.canSend ? (
              <p className="cmp-test-ok">
                WhatsApp lets this number send
                {view.dailyLimit ? ` — up to ${view.dailyLimit.toLocaleString()} new conversations a day` : ""}
                {view.dailyLimit && view.usedToday !== null ? `, and at least ${view.usedToday} have gone out today` : ""}.
              </p>
            ) : null}
          </>
        )}
      </section>

      {view ? (
        <>
          <section className="bk-step">
            <h2>
              <span>2</span> Customers
            </h2>
            <div className="ecf-tabs" role="tablist" aria-label="Choose or add customers">
              <button type="button" role="tab" aria-selected={customersTab === "pick"} className={customersTab === "pick" ? "on" : ""} onClick={() => setCustomersTab("pick")}>
                Pick customers<b>{customers.length}</b>
              </button>
              <button type="button" role="tab" aria-selected={customersTab === "add"} className={customersTab === "add" ? "on" : ""} onClick={() => setCustomersTab("add")}>
                + Add numbers
              </button>
            </div>
            {customersTab === "add" ? (
              <AddNumbers
                business={business}
                businessName={tenantName(business)}
                numberId={numberId}
                known={knownNumbers}
                onAdded={(ids) => void onNumbersAdded(ids)}
                onShowList={() => setCustomersTab("pick")}
              />
            ) : (
              <ClientsTab
                clients={customers}
                selected={picked}
                onChange={setPicked}
                title={`${customers.length} customers of this business`}
                where="this number"
                justAdded={justAdded}
                onSend={(next) => {
                  setKind(next);
                  compose.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            )}
          </section>

          <section className="bk-step" ref={compose}>
            <h2>
              <span>3</span> Message
            </h2>
            {chosen.length === 0 ? (
              <p className="mc-empty">Tick at least one customer above.</p>
            ) : (
              <>
                {newNeverWrote > 0 ? (
                  <p className="bk-note">
                    These {newNeverWrote} have never written to this number, so WhatsApp lets them get an approved message
                    only.
                  </p>
                ) : null}
                <div className="ecf-tabs" role="tablist" aria-label="Kind of message">
                  <button type="button" role="tab" aria-selected={kind === "approved"} className={kind === "approved" ? "on" : ""} onClick={() => setKind("approved")}>
                    Approved message<b>{chosen.length}</b>
                  </button>
                  <button type="button" role="tab" aria-selected={kind === "quick"} className={kind === "quick" ? "on" : ""} onClick={() => setKind("quick")}>
                    Quick message<b>{inWindow.length}</b>
                  </button>
                </div>

                {kind === "quick" ? (
                  <QuickMessage
                    ownNumber
                    people={inWindow}
                    bookSize={chosen.length}
                    where="this number"
                    send={(text) => sendBulkQuick(business, { phoneNumberId: numberId, text, contactIds: inWindow.map((c) => c.id) })}
                    onSent={() => void loadOverview(business)}
                    assist={(put, current) => (
                      <AiWriter
                        business={business}
                        kind="quick"
                        sampleName={inWindow[0]?.displayName ?? null}
                        current={current}
                        onUse={put}
                      />
                    )}
                  />
                ) : (
                  <ApprovedSend
                    business={business}
                    numberId={numberId}
                    numberLabel={number?.label ?? ""}
                    view={view}
                    templateId={templateId}
                    setTemplateId={setTemplateId}
                    chosen={chosen}
                    chosenIds={chosenIds}
                    onSent={() => void loadOverview(business)}
                    onTemplatesChanged={(id) => void reloadNumber(id)}
                  />
                )}
              </>
            )}
          </section>
        </>
      ) : null}

      <section className="cmp-history">
        <h2>Recent campaigns</h2>
        {campaigns.length ? (
          <table className="mc-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Message</th>
                <th scope="col">Sent</th>
                <th scope="col">Delivered</th>
                <th scope="col">Failed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>{new Date(campaign.createdAt).toLocaleString()}</td>
                  <td>{campaign.channel === "email" ? campaign.emailSubject : campaign.templateName ?? "—"}</td>
                  <td className="mc-num">
                    {campaign.sent} of {campaign.recipients}
                  </td>
                  <td className="mc-num">{campaign.delivered || "—"}</td>
                  <td className="mc-num">
                    {campaign.failed || "—"}
                    {campaign.failureReasons.length ? (
                      <ul className="cmp-why">
                        {campaign.failureReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td>{STATUS_WORDS[campaign.status] ?? campaign.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mc-empty">Nothing sent for this business yet.</p>
        )}
      </section>
    </div>
  );
}

/** An approved message: pick it, read it, test it, then send to the ticked customers. */
function ApprovedSend({
  business,
  numberId,
  numberLabel,
  view,
  templateId,
  setTemplateId,
  chosen,
  chosenIds,
  onSent,
  onTemplatesChanged,
}: {
  business: BusinessSlug;
  numberId: string;
  numberLabel: string;
  view: BulkNumberView;
  templateId: string;
  setTemplateId: (id: string) => void;
  chosen: BulkNumberView["customers"];
  chosenIds: string[];
  onSent: () => void;
  /** A new approved message was sent or checked; with an id, it was just approved. */
  onTemplatesChanged: (approvedTemplateId?: string) => void;
}) {
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function watchTest(messageId: string) {
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status: CampaignTestStatus | null = await getBulkTestStatus(messageId).catch(() => null);
      if (!status) continue;
      if (status.state === "failed") return setTestNote({ ok: false, text: `WhatsApp did not deliver it: ${status.reason ?? "no reason given."}` });
      if (status.state === "delivered" || status.state === "read") return setTestNote({ ok: true, text: "Delivered to that WhatsApp." });
    }
    setTestNote({ ok: true, text: "WhatsApp accepted it but has not confirmed delivery yet." });
  }

  return (
    <div className="cmp-compose">
      <label className="cmp-pick">
        <span>Message</span>
        <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
          <option value="">Choose an approved message…</option>
          {view.templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.language})
            </option>
          ))}
        </select>
        <em>Only messages WhatsApp approved on this number&rsquo;s account appear here.</em>
      </label>

      <NewApproved
        business={business}
        numberId={numberId}
        pending={view.pending ?? []}
        sampleName={chosen[0]?.displayName ?? null}
        onChanged={onTemplatesChanged}
      />

      {templateId ? (
        <TemplateText
          loadKey={`${numberId}:${templateId}`}
          load={() => getBulkTemplateText(business, numberId, templateId)}
          sampleName={chosen[0]?.displayName ?? null}
        />
      ) : null}

      {templateId ? (
        <div className="cmp-test">
          <label>
            <span>Try it on your own WhatsApp first</span>
            <input type="tel" inputMode="tel" placeholder="+971 50 123 4567" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={testing || !testTo.trim()}
            onClick={async () => {
              setTesting(true);
              setTestNote(null);
              try {
                const { messageId } = await sendBulkTest(business, { phoneNumberId: numberId, templateId, to: testTo.trim() });
                setTestNote({ ok: true, text: "WhatsApp accepted it. Waiting to hear whether it reached the phone…" });
                if (messageId) void watchTest(messageId);
              } catch (err) {
                setTestNote({ ok: false, text: readableError(err) });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? "Sending test…" : "Send a test"}
          </button>
          {testNote ? <p className={testNote.ok ? "cmp-test-ok" : "mc-error"}>{testNote.text}</p> : null}
        </div>
      ) : null}

      {!confirming ? (
        <button type="button" className="cmp-go" disabled={!templateId || !view.canSend} onClick={() => setConfirming(true)}>
          Review before sending
        </button>
      ) : (
        <div className="cmp-confirm">
          <h3>
            This will message {chosen.length} {chosen.length === 1 ? "customer" : "customers"}
          </h3>
          <ul className="cmp-who">
            {chosen.map((person) => (
              <li key={person.id}>
                {person.displayName ?? "Unnamed"} <span>+{person.waId}</span>
              </li>
            ))}
          </ul>
          <p className="cmp-final">
            Sending <strong>{view.templates.find((t) => t.id === templateId)?.name}</strong> from <strong>{numberLabel}</strong>.
            This cannot be recalled once it starts.
          </p>
          {/* THE CEILING AT THE POINT OF NO RETURN: Meta limits how many new
              conversations a number starts per 24 hours; past it, the rest
              quietly do not arrive today. */}
          {view.dailyLimit && view.usedToday !== null && chosen.length > Math.max(0, view.dailyLimit - view.usedToday) ? (
            <p className="cmp-final cmp-warn-line">
              About {Math.max(0, view.dailyLimit - view.usedToday)} of these {chosen.length} will arrive today — the rest run
              past what WhatsApp allows this number to start in 24 hours.
            </p>
          ) : null}
          <div className="cmp-actions">
            <button
              type="button"
              className="cmp-go"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                setResult(null);
                try {
                  const outcome = await sendBulk(business, { phoneNumberId: numberId, templateId, contactIds: chosenIds });
                  setResult({ ok: true, text: `Queued to ${outcome.enqueued} customers. Delivery shows below as WhatsApp confirms it.` });
                  setConfirming(false);
                  onSent();
                } catch (err) {
                  setResult({ ok: false, text: readableError(err, "Nothing was sent.") });
                } finally {
                  setSending(false);
                }
              }}
            >
              {sending ? "Sending…" : `Message ${chosen.length} ${chosen.length === 1 ? "customer" : "customers"}`}
            </button>
            <button type="button" className="cmp-cancel" onClick={() => setConfirming(false)}>
              Not yet
            </button>
          </div>
        </div>
      )}
      {result ? <p className={result.ok ? "cmp-sent" : "mc-error"}>{result.text}</p> : null}
    </div>
  );
}
