"use client";

import { useEffect, useState } from "react";
import type { BusinessSlug, InboxSettings } from "@nexus/shared";
import { getInboxSettings, updateInboxSettings, readableError } from "@/lib/api";

/**
 * How one business's inbox behaves — the owner's three switches.
 *
 * These settings (migration 090, 092) had an API and no screen: the reply-time
 * target and the pipeline stages could only be changed by somebody who knew
 * the endpoint. They sit here beside the team because each is about how the
 * TEAM works the inbox: who a new chat goes to, how long is too long, and the
 * stages a lead moves through.
 *
 * Each control saves on its own and adopts what the server kept, so what is on
 * screen is always what is stored.
 */
export function InboxRules({ slug }: { slug: BusinessSlug }) {
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [stagesDraft, setStagesDraft] = useState("");
  const [slaDraft, setSlaDraft] = useState("");
  const [saving, setSaving] = useState<"" | "assign" | "sla" | "stages">("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSettings(null);
    setError(null);
    setSaved(null);
    getInboxSettings(slug)
      .then(({ settings: s }) => {
        if (!live) return;
        setSettings(s);
        setStagesDraft(s.stages.join(", "));
        setSlaDraft(String(s.slaMinutes));
      })
      .catch((err) => live && setError(readableError(err, "Could not load the inbox rules.")));
    return () => {
      live = false;
    };
  }, [slug]);

  async function save(
    which: "assign" | "sla" | "stages",
    patch: { autoAssign?: boolean; slaMinutes?: number | null; stages?: string[] | null },
    done: string
  ) {
    setSaving(which);
    setError(null);
    setSaved(null);
    try {
      const { settings: s } = await updateInboxSettings(slug, patch);
      setSettings(s);
      setStagesDraft(s.stages.join(", "));
      setSlaDraft(String(s.slaMinutes));
      setSaved(done);
    } catch (err) {
      setError(readableError(err, "That change did not save."));
    } finally {
      setSaving("");
    }
  }

  return (
    <section className="rules">
      <header className="rules-head">
        <h2>Inbox rules</h2>
        <p>How this business&apos;s chats are handed out and timed.</p>
      </header>

      {!settings ? (
        error ? <p className="team-msg bad">{error}</p> : <span className="nx-skel" style={{ width: "40%" }} />
      ) : (
        <div className="rules-grid">
          <div className="rules-card">
            <label className="rules-switch">
              <input
                type="checkbox"
                checked={settings.autoAssign}
                disabled={saving === "assign"}
                onChange={(e) =>
                  void save(
                    "assign",
                    { autoAssign: e.target.checked },
                    e.target.checked ? "Auto-assign is on." : "Auto-assign is off."
                  )
                }
              />
              <span className="rules-knob" aria-hidden="true" />
              <b>Auto-assign new chats</b>
            </label>
            <p className="rules-note">
              A chat nobody has goes to the person on shift with the fewest open chats, taking turns. Only staff whose
              AI twin is on are picked — so when they step away, their twin keeps answering in their name. Someone
              with the twin off can still be given chats by hand.
            </p>
          </div>

          <form
            className="rules-card"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(slaDraft);
              void save("sla", { slaMinutes: Number.isFinite(n) ? n : null }, "Reply-time target saved.");
            }}
          >
            <b className="rules-label">Reply-time target</b>
            <div className="rules-row">
              <input
                className="rules-input short"
                type="number"
                min={5}
                max={10080}
                value={slaDraft}
                onChange={(e) => setSlaDraft(e.target.value)}
                aria-label="Reply-time target in minutes"
              />
              <span className="rules-unit">minutes</span>
              <button type="submit" className="rules-save" disabled={saving === "sla"}>
                {saving === "sla" ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="rules-note">A customer waiting longer than this shows as “SLA breached” in the inbox.</p>
          </form>

          <form
            className="rules-card wide"
            onSubmit={(e) => {
              e.preventDefault();
              const stages = stagesDraft
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              void save("stages", { stages: stages.length ? stages : null }, "Pipeline stages saved.");
            }}
          >
            <b className="rules-label">Pipeline stages</b>
            <div className="rules-row">
              <input
                className="rules-input"
                value={stagesDraft}
                onChange={(e) => setStagesDraft(e.target.value)}
                aria-label="Pipeline stages, separated by commas"
              />
              <button type="submit" className="rules-save" disabled={saving === "stages"}>
                {saving === "stages" ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="rules-note">
              In order, separated by commas — they become the tabs across the top of the inbox. Leave empty to go back
              to the defaults.
            </p>
          </form>
        </div>
      )}
      {settings && error ? <p className="team-msg bad">{error}</p> : null}
      {saved && !error ? <p className="team-msg ok">{saved}</p> : null}
    </section>
  );
}
