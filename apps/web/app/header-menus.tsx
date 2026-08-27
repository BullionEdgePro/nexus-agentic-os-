"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  searchAll,
  getMe,
  updateMe,
  getTasks,
  getFindings,
  type SearchHit,
  type Me,
  type TaskRecord,
  type OperatorFinding, readableError } from "@/lib/api";
import "./header-menus.css";

/**
 * The four header controls, each with something real behind it.
 *
 * THE SPLIT BETWEEN THE FIRST TWO IS THE DESIGN, and it is worth stating
 * because "alerts" and "notifications" are usually the same list twice:
 *
 *   To do    — what YOU must act on. A customer waiting, a promise past its
 *              date, work nobody has been given. It persists until somebody
 *              does something. Closing the panel changes nothing.
 *
 *   Activity — what HAPPENED that you may not have seen. New since you last
 *              looked, and opening it marks it seen. It is a diff, not a queue.
 *
 * The same finding can appear in both, and that is correct: a customer who
 * started waiting an hour ago is both news and work. What would be wrong is
 * two lists that claim to be different and are not.
 */

/* ------------------------------------------------------------------ */
/* shared: a panel that closes on Escape and on a click outside        */
/* ------------------------------------------------------------------ */

function useDismissable(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", onKey);
    // `mousedown`, not `click`: a click that starts inside the panel and ends
    // outside it — a text selection dragged past the edge — would otherwise
    // close the panel mid-drag.
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  return ref;
}

/* ------------------------------------------------------------------ */
/* 1. Search                                                           */
/* ------------------------------------------------------------------ */

export function HeaderSearch() {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrap = useDismissable(open, () => setOpen(false));

  // ⌘K / Ctrl-K focuses the box. The shortcut was printed on the old search
  // box as a <kbd> hint while nothing listened for it — a label describing a
  // feature that did not exist.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Debounced. Every keystroke firing a query would put five requests in
  // flight for a five-letter name and render whichever returned last, which is
  // not necessarily the one matching what is now in the box.
  useEffect(() => {
    if (term.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      searchAll(term)
        .then((data) => {
          if (!cancelled) setHits(data.hits);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const showPanel = open && term.trim().length >= 2;

  return (
    <div className="hs" ref={wrap}>
      <div className="hs-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search people and follow-ups…"
          aria-label="Search people and follow-ups"
          spellCheck={false}
        />
        <kbd>⌘K</kbd>
      </div>

      {showPanel ? (
        <div className="hs-panel" role="listbox">
          {busy && hits.length === 0 ? (
            <p className="hs-note">Searching…</p>
          ) : hits.length === 0 ? (
            // Names the scope. "No results" leaves someone wondering whether
            // the thing is missing or simply not searchable here.
            <p className="hs-note">
              Nothing matches &ldquo;{term.trim()}&rdquo;. This searches customer names, phone
              numbers and follow-up titles — not message text.
            </p>
          ) : (
            <ul>
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <a href={hit.href}>
                    <span className={`hs-kind ${hit.kind}`}>
                      {hit.kind === "contact" ? "Person" : "Follow-up"}
                    </span>
                    <span className="hs-title">{hit.title}</span>
                    <span className="hs-meta">
                      {hit.detail ? `${hit.detail} · ` : ""}
                      {hit.businessName}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. To do — what needs acting on                                     */
/* ------------------------------------------------------------------ */

export function WorkMenu() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [waiting, setWaiting] = useState<OperatorFinding[]>([]);
  const [counts, setCounts] = useState({ overdue: 0, unassigned: 0, open: 0 });
  const [unanswered, setUnanswered] = useState(false);
  const wrap = useDismissable(open, () => setOpen(false));

  const load = useCallback(() => {
    // Both, because `due` is a sum across both and the empty state below makes
    // a claim about each of them by name. Either failing makes that sentence a
    // statement about something nobody asked.
    let broke = false;
    const admit = () => {
      broke = true;
      setUnanswered(true);
    };
    const settle = () => {
      if (!broke) setUnanswered(false);
    };
    getTasks({ status: "open" })
      .then((d) => {
        setTasks(d.tasks);
        setCounts(d.counts);
        settle();
      })
      .catch(admit);
    getFindings()
      .then((d) => {
        setWaiting(d.findings.filter((f) => f.operator === "customer-waiting"));
        settle();
      })
      .catch(admit);
  }, []);

  useEffect(() => {
    load();
    // Re-read every two minutes. The operator sweep runs every ten, so polling
    // faster would spend requests to show the same numbers back.
    const timer = setInterval(load, 120_000);
    return () => clearInterval(timer);
  }, [load]);

  // What actually demands action, not everything outstanding. A follow-up due
  // next week is real work and does not belong in a badge today.
  const due = counts.overdue + counts.unassigned + waiting.length;

  const overdue = useMemo(() => tasks.filter((t) => t.isOverdue), [tasks]);
  const unowned = useMemo(() => tasks.filter((t) => !t.employeeId && !t.isOverdue), [tasks]);

  return (
    <div className="hm" ref={wrap}>
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={
          unanswered
            ? "Could not check what needs doing"
            : due
              ? `${due} things need doing`
              : "Nothing needs doing"
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M9 5h11M9 12h11M9 19h11" />
          <path d="M3.5 5.2l1.3 1.3L7.4 3.9M3.5 12.2l1.3 1.3 2.6-2.6M3.5 19.2l1.3 1.3 2.6-2.6" />
        </svg>
        {due ? (
          <span className="badge">{due > 99 ? "99+" : due}</span>
        ) : unanswered ? (
          <span className="badge dot-only unknown" />
        ) : null}
      </button>

      {open ? (
        <div className="hm-panel">
          <div className="hm-head">
            <strong>To do</strong>
            <span>
              {unanswered ? "could not check" : due ? `${due} needing action` : "nothing right now"}
            </span>
          </div>

          {unanswered ? (
            <p className="hm-empty unknown">
              Some of this could not be read just now. If the list below is short or empty, that
              is not the same as nothing needing doing.
            </p>
          ) : null}

          {due === 0 && !unanswered ? (
            <p className="hm-empty">
              No customer is waiting, nothing promised is overdue, and every follow-up has an
              owner.
            </p>
          ) : null}

          {due > 0 ? (
            <ul className="hm-list">
              {waiting.slice(0, 4).map((f) => (
                <li key={f.id}>
                  <a href="/deck/operators">
                    <span className="hm-tag urgent">Waiting</span>
                    <span className="hm-t">{f.title}</span>
                    <span className="hm-m">{f.businessName}</span>
                  </a>
                </li>
              ))}
              {overdue.slice(0, 4).map((t) => (
                <li key={t.id}>
                  <a href="/deck/tasks">
                    <span className="hm-tag late">Overdue</span>
                    <span className="hm-t">{t.title}</span>
                    <span className="hm-m">
                      {t.businessName}
                      {t.employeeName ? ` · ${t.employeeName}` : " · nobody's job"}
                    </span>
                  </a>
                </li>
              ))}
              {unowned.slice(0, 3).map((t) => (
                <li key={t.id}>
                  <a href="/deck/tasks">
                    <span className="hm-tag warn">Unassigned</span>
                    <span className="hm-t">{t.title}</span>
                    <span className="hm-m">{t.businessName}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="hm-foot">
            <a href="/deck/tasks">All follow-ups</a>
            <a href="/deck/operators">Needs attention</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Activity — what happened since you last looked                   */
/* ------------------------------------------------------------------ */

const SEEN_KEY = "nexus.activity.seenAt";

export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const [findings, setFindings] = useState<OperatorFinding[]>([]);
  /**
   * Work assigned to whoever is signed in.
   *
   * WHY THIS IS HERE AT ALL. Until 2026-08-25 nothing in this platform ever
   * told a person they had been given something. The board could be filtered to
   * an owner and the API had taken ?mine=1 for months, but both need somebody
   * to go and look -- and since automations landed, a rule can assign a
   * follow-up at three in the morning with nobody in the loop at all.
   *
   * Empty for an operator, who has no employee row. The server drops the filter
   * for them rather than matching nothing, so this is safe to ask for without
   * knowing which kind of session it is.
   */
  const [mine, setMine] = useState<TaskRecord[]>([]);
  /**
   * Whether the checks could be REACHED, which is not the same as whether
   * they found anything.
   *
   * THREE STATES, NOT TWO — the same shape /deck/operators uses for its alert
   * destination, and for the same reason. This bell swallowed a failed fetch
   * into an empty list, so an outage, an expired session or a 500 rendered as
   * a dark bell: "nothing needs attention".
   *
   * That is the failure this control exists to prevent, arriving through the
   * one door nobody was watching. It polls every two minutes, so a blip heals
   * itself; a session that has expired does not, and the bell stays dark for
   * as long as somebody leaves the tab open.
   */
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [seenAt, setSeenAt] = useState<number>(0);
  const wrap = useDismissable(open, () => setOpen(false));

  useEffect(() => {
    // Read once on mount. localStorage is per-browser, so "seen" means seen on
    // this machine — which is the honest meaning for a per-person marker with
    // no per-person storage behind it. Recording it server-side would need a
    // table whose only reader is this badge.
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SEEN_KEY) : null;
    setSeenAt(raw ? Number(raw) || 0 : 0);
  }, []);

  const load = useCallback(() => {
    getFindings()
      .then((d) => {
        setFindings(d.findings);
        setReachable(true);
      })
      .catch(() => setReachable(false));
    // The LISTS fail separately -- a person's own work must still show when the
    // checks are unreachable, and the checks must still show when this is. One
    // catch for both would have lost whichever came second.
    //
    // The BADGE does not. Its dark state is a claim about everything the bell
    // covers, and `mine.length` is one of the three terms that lights it, so a
    // failure here darkens a dot that had work behind it. The comment that used
    // to sit above said this fetch "does not darken anything that was lit",
    // which was written in the same hour as the fix for exactly that defect on
    // the fetch above it, and was simply wrong.
    getTasks({ mine: true, status: "open" })
      .then((d) => setMine(d.tasks))
      .catch(() => setReachable(false));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 120_000);
    return () => clearInterval(timer);
  }, [load]);

  const fresh = useMemo(
    () => findings.filter((f) => new Date(f.firstSeenAt).getTime() > seenAt),
    [findings, seenAt]
  );

  /**
   * Yours and already late.
   *
   * `isOverdue` is the SERVER's verdict and is not recomputed here, for the
   * reason written on the board's columns: a browser clock that is behind would
   * quietly declare late work fine.
   */
  const mineOverdue = useMemo(() => mine.filter((t) => t.isOverdue), [mine]);

  /**
   * Urgent, open, and nobody has said they are dealing with it.
   *
   * SEEN IS NOT THE SAME AS ANSWERED, and this badge treated them as one thing.
   * `fresh` is "raised since you last opened this panel", and `seenAt` is set on
   * OPEN — so a single glance marked everything currently there as seen, for
   * ever, on that machine. An urgent finding then stops being mentioned while
   * remaining completely unactioned.
   *
   * That is not hypothetical. On 2026-08-24 one urgent finding had been open
   * since the 19th — a customer waiting 116 hours for a person — and the bell
   * was dark, because the panel had been opened at some point in between.
   *
   * The platform already has an honest signal for "somebody is dealing with
   * this": the dismissal, which is explicit, carries a reason, and LAPSES the
   * moment the finding does. A localStorage timestamp from one glance is not
   * that. So urgent findings nag until they are dismissed or resolved, and
   * `fresh` goes on doing its narrower job for everything else.
   */
  const nagging = useMemo(
    () => findings.filter((f) => f.severity === "urgent" && !f.dismissedAt),
    [findings]
  );

  function openAndMarkSeen() {
    const next = !open;
    setOpen(next);
    if (next) {
      // Marked on OPEN, not on close. Someone who opens the panel and reads it
      // has seen it, whether or not they remember to close it deliberately.
      const now = Date.now();
      window.localStorage.setItem(SEEN_KEY, String(now));
      setSeenAt(now);
    }
  }

  return (
    <div className="hm" ref={wrap}>
      <button
        className="icon-btn"
        onClick={openAndMarkSeen}
        aria-expanded={open}
        title={
          [
            // Yours comes first. Everything else on this badge is about the
            // business; this part is about the person reading it.
            mine.length
              ? `${mine.length} assigned to you` +
                (mineOverdue.length ? ` (${mineOverdue.length} late)` : "")
              : "",
            nagging.length ? `${nagging.length} urgent, not yet accepted` : "",
            fresh.length ? `${fresh.length} new since you last looked` : "",
          ]
            .filter(Boolean)
            .join(" · ") ||
          (reachable === false ? "The checks could not be reached" : "Activity")
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7Z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {/* A THIRD DOT, because there are three things to say and a dark bell
            was saying the wrong one. Muted, not red: nothing is known to be
            wrong, and treating "cannot tell" as an alarm would be the
            opposite mistake. */}
        {reachable === false ? (
          <span className="badge dot-only unknown" aria-hidden="true" />
        ) : nagging.length || fresh.length || mine.length ? (
          // Urgent gets its own colour. A dot that means "something new" and a
          // dot that means "somebody has been waiting five days" should not be
          // the same dot -- and work of yours that is already late belongs in
          // the second group, not the first.
          <span
            className={
              nagging.length || mineOverdue.length ? "badge dot-only urgent" : "badge dot-only"
            }
            aria-hidden="true"
          />
        ) : null}
      </button>

      {open ? (
        <div className="hm-panel">
          <div className="hm-head">
            <strong>Activity</strong>
            <span>
              {nagging.length
                ? `${nagging.length} urgent`
                : fresh.length
                  ? `${fresh.length} new`
                  : "nothing new"}
            </span>
          </div>

          {/* YOURS, AND IT DOES NOT CLEAR WHEN YOU LOOK AT IT.
              `fresh` below is deliberately a "since you last opened this panel"
              marker, and this section is deliberately not: a glance is not the
              same as doing the work, and this platform has already shipped that
              exact confusion once -- a single opening of this panel permanently
              silenced a customer who had been waiting five days. This list
              empties when the follow-ups are closed and at no other time. */}
          {reachable === false ? (
            <p className="hm-empty hm-unreachable">
              The checks could not be reached, so this is not a report that nothing is wrong —
              it is no report at all. It retries every two minutes.
            </p>
          ) : null}

          {mine.length > 0 ? (
            <div className="hm-mine">
              <div className="hm-mine-head">
                <strong>Yours</strong>
                <span>
                  {mineOverdue.length
                    ? `${mineOverdue.length} late of ${mine.length}`
                    : `${mine.length} open`}
                </span>
              </div>
              <ul className="hm-list">
                {mine.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <a href="/deck/board">
                      <span className={`hm-tag ${t.isOverdue ? "urgent" : "warn"}`}>
                        {t.isOverdue ? "late" : "yours"}
                      </span>
                      <span className="hm-t">{t.title}</span>
                      <span className="hm-m">
                        {t.businessName}
                        {t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleDateString()}` : " · no date"}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {findings.length === 0 ? (
            <p className="hm-empty">
              Nothing has been raised. The checks run every ten minutes across every business.
            </p>
          ) : (
            <ul className="hm-list">
              {findings.slice(0, 8).map((f) => {
                const isNew = new Date(f.firstSeenAt).getTime() > seenAt;
                return (
                  <li key={f.id} className={isNew ? "new" : undefined}>
                    <a href="/deck/operators">
                      <span className={`hm-tag ${f.severity === "urgent" ? "urgent" : "warn"}`}>
                        {f.operator.replace(/-/g, " ")}
                      </span>
                      <span className="hm-t">{f.title}</span>
                      <span className="hm-m">
                        {f.businessName} · {ago(f.firstSeenAt)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="hm-foot">
            <a href="/deck/operators">Everything being watched</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/* 4. Account                                                          */
/* ------------------------------------------------------------------ */

export function AccountMenu({ signedInAs }: { signedInAs: string }) {
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const wrap = useDismissable(open, () => setOpen(false));

  const [name, setName] = useState("");
  const [wa, setWa] = useState("");
  const [avatar, setAvatar] = useState("");

  useEffect(() => {
    getMe()
      .then((data) => {
        setMe(data);
        setName(data.fullName ?? "");
        setWa(data.whatsappNumber ?? "");
        setAvatar(data.avatarUrl ?? "");
      })
      .catch(() => undefined);
  }, []);

  const initials = useMemo(() => {
    const source = me?.fullName || me?.email || signedInAs;
    const words = source.split("@")[0].split(/[\s._-]+/).filter(Boolean);
    const letters =
      words.length > 1
        ? (words[0][0] ?? "") + (words[1][0] ?? "")
        : (words[0] ?? "").slice(0, 2);
    return (letters.replace(/[^a-zA-Z0-9]/g, "") || "OP").toUpperCase();
  }, [me, signedInAs]);

  /**
   * Resize in the browser, then send the picture inline.
   *
   * There is no object storage on this deployment. Rather than pretend a file
   * can be uploaded, the file IS read here, drawn to a 256px canvas and
   * exported as a JPEG data URI — small enough to sit in the profile row and
   * be sent with every read. A phone camera photo is several megabytes; sent
   * raw it would trip the size cap and the person would be told their
   * perfectly ordinary photo was too big.
   */
  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared immediately so choosing the same file twice fires again — the
    // input does not change value when the pick is identical.
    e.target.value = "";
    if (!file) return;

    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError("Choose a PNG, JPEG or WebP. SVG is not accepted — it can carry scripts.");
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read.");
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => setError("That file is not an image this browser can open.");
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setError("This browser cannot process the image.");
          return;
        }
        // Square crop from the centre. Squashing a portrait into a circle is
        // worse than trimming it.
        const side = Math.min(img.width, img.height);
        ctx.drawImage(
          img,
          (img.width - side) / 2,
          (img.height - side) / 2,
          side,
          side,
          0,
          0,
          size,
          size
        );
        setAvatar(canvas.toDataURL("image/jpeg", 0.82));
        setError("");
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await updateMe({
        fullName: name.trim() || undefined,
        whatsappNumber: wa.trim() ? wa.trim() : null,
        avatarUrl: avatar.trim() ? avatar.trim() : null,
      });
      const fresh = await getMe();
      setMe(fresh);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      // The API's messages are written for a person — an unusable number, a
      // non-https image address — so they are shown rather than replaced.
      const raw = readableError(err);
      setError(raw.replace(/^API \d+ on [^:]+: /, "").replace(/^\{"error":"|"\}$/g, ""));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="hm hm-right" ref={wrap}>
      <button
        className="avatar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={me?.email ?? signedInAs}
      >
        {me?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={me.avatarUrl} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
        ) : (
          initials
        )}
      </button>

      {open ? (
        <div className="hm-panel acct">
          <div className="acct-id">
            <div className="acct-face">
              {me?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={me.avatarUrl} alt="" />
              ) : (
                initials
              )}
            </div>
            <div className="acct-who">
              <strong>{me?.fullName ?? me?.email ?? signedInAs}</strong>
              <span>{me?.email ?? signedInAs}</span>
              <span className="acct-role">
                {me?.role === "operator"
                  ? "Operator · every business"
                  : `${me?.jobTitle ? `${me.jobTitle} · ` : ""}${me?.businessName ?? ""}`}
              </span>
              {/*
                YOUR OWN LAST SIGN-IN, because you are the only person who can
                say whether it was you. A shared or leaked code looks like
                ordinary use from every other angle and like an unfamiliar
                device from this one.

                Only when it is known: an account whose sign-in predates this
                being recorded should say nothing rather than "Unknown device",
                which would read as a warning about a session that was fine.
              */}
              {me?.lastLoginAt ? (
                <span className="acct-signin">
                  Last signed in {new Date(me.lastLoginAt).toLocaleString()}
                  {me.lastLoginDevice ? ` · ${me.lastLoginDevice}` : ""}
                </span>
              ) : null}
            </div>
          </div>

          {me?.editable && !editing ? (
            <dl className="acct-rows">
              <div>
                <dt>Email</dt>
                <dd>{me.email}</dd>
              </div>
              <div>
                <dt>{me.role === "employee" ? "WhatsApp" : "Contact number"}</dt>
                <dd>
                  {me.whatsappNumber ? (
                    `+${me.whatsappNumber}`
                  ) : me.role === "employee" ? (
                    // Not blank. This number is what a customer handed to this
                    // person gets messaged from, so its absence is a real gap.
                    <em>not set — customers cannot be handed to you directly</em>
                  ) : (
                    <em>not set</em>
                  )}
                </dd>
              </div>
              {me.role === "employee" ? (
              <div>
                <dt>Staff code</dt>
                <dd>{me.employeeCode}</dd>
              </div>
              ) : (
              <div>
                <dt>Access</dt>
                <dd>Every business on the platform</dd>
              </div>
              )}
            </dl>
          ) : null}

          {me?.editable && editing ? (
            <form className="acct-form" onSubmit={save}>
              <label>
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
              </label>
              {/* Read-only, and the reason is given. A greyed-out box people
                  try to click and cannot is worse than a plain statement. */}
              <div className="acct-fixed">
                <span>Email</span>
                <p>
                  {me.email}
                  <em>how you sign in — an operator changes it, not this form</em>
                </p>
              </div>

              <label>
                <span>{me.role === "employee" ? "Your WhatsApp number" : "Your contact number"}</span>
                <input
                  value={wa}
                  onChange={(e) => setWa(e.target.value)}
                  placeholder="971500000000"
                  inputMode="tel"
                />
                {/* An operator's number is a record, not a route. Said here so
                    nobody sets it expecting customers to start arriving. */}
                {me.role === "operator" ? (
                  <em className="acct-sub">
                    On record only — operators do not take customer handoffs.
                  </em>
                ) : null}
              </label>
              <label>
                <span>Photo</span>
                <div className="acct-photo">
                  {avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatar} alt="" className="acct-preview" />
                  ) : (
                    <span className="acct-preview empty">{initials}</span>
                  )}
                  <div className="acct-photo-acts">
                    <label className="acct-file">
                      Choose a file
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={onPickFile}
                      />
                    </label>
                    {avatar ? (
                      <button type="button" className="quiet" onClick={() => setAvatar("")}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </label>

              <label>
                <span>…or paste a link</span>
                <input
                  // A chosen file lives in the same state as a pasted link, so
                  // the box would otherwise fill with 30KB of base64.
                  value={avatar.startsWith("data:") ? "" : avatar}
                  onChange={(e) => setAvatar(e.target.value)}
                  placeholder="https://…/me.jpg"
                  spellCheck={false}
                />
              </label>

              {/* Stated rather than discovered. There is no object storage on
                  this deployment, so a chosen file is resized in the browser
                  and stored inline — which is why it has a size limit, and why
                  the link option stays for anything larger. */}
              <p className="acct-hint">
                A chosen file is shrunk to 256px and saved with your profile. For a larger image,
                host it somewhere and paste the https link instead.
              </p>
              {error ? <p className="acct-err">{error}</p> : null}
              <div className="acct-actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button type="button" className="quiet" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          <div className="acct-foot">
            {me?.editable && !editing ? (
              <button className="quiet" onClick={() => setEditing(true)}>
                Edit profile
              </button>
            ) : (
              <span className="acct-note" />
            )}
            {saved ? <span className="acct-saved">Saved</span> : null}
            {/* A link, like the rail. One route, one behaviour, and it works
                if the click handler never runs. */}
            <a className="acct-out" href="/api/auth/logout">
              Sign out
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
