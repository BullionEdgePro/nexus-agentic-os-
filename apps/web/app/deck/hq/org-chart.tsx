"use client";

import { useState } from "react";
import {
  addHqOrgMember,
  saveHqOrgNode,
  removeHqOrgMember,
  readableError,
  type HqOrgChart,
  type HqOrgNode,
  type HqGroupView,
} from "@/lib/api";

/**
 * Organizational charts in Business HQ (owner-approved 14 Oct 2026).
 *
 * The tree is drawn from the API's chart (owner on top, Nexus staff, people
 * added by hand, vacancies). "Edit structure" turns each card into a small
 * form: who they report to and their department; people not on Nexus and open
 * roles are added below. The server refuses a reporting loop in words.
 */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const initials = (name: string) =>
  name
    .replace(/^Hiring:\s*/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Everyone on the chart except `exclude` and their own people (who cannot be their manager). */
function managerOptions(root: HqOrgNode, exclude: HqOrgNode): HqOrgNode[] {
  const out: HqOrgNode[] = [];
  const walk = (n: HqOrgNode) => {
    if (n.id === exclude.id) return; // skips the person and everyone under them
    if (n.kind !== "vacancy") out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

function Card({ node, editing, root, slug, onChanged }: { node: HqOrgNode; editing: boolean; root: HqOrgNode; slug: string; onChanged: () => void }) {
  const parentId = (() => {
    let found = "owner";
    const walk = (n: HqOrgNode) => n.children.forEach((c) => (c.id === node.id ? (found = n.id) : walk(c)));
    walk(root);
    return found;
  })();
  const [reportsTo, setReportsTo] = useState(parentId);
  const [department, setDepartment] = useState(node.department ?? "");
  const [msg, setMsg] = useState("");

  async function save() {
    setMsg("");
    try {
      await saveHqOrgNode(slug, node.id, { reportsTo, department: department || null });
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }
  async function remove() {
    if (!window.confirm(`Remove ${node.name} from the chart?`)) return;
    try {
      await removeHqOrgMember(slug, node.id);
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }

  return (
    <div className={`hq-org-card ${node.kind}`}>
      <div className="hq-org-avatar" aria-hidden>
        {node.avatarUrl ? <img src={node.avatarUrl} alt="" /> : initials(node.name) || "?"}
        {node.onShift ? <span className="hq-org-live" title="On shift now" /> : null}
      </div>
      <div className="hq-org-who">
        <strong>{node.name}</strong>
        {node.title ? <span className="hq-org-title">{node.title}</span> : null}
        <div className="hq-org-badges">
          {node.department ? <span className="hq-org-dept">{node.department}</span> : null}
          {node.onShift ? <span className="hq-org-badge live">On shift</span> : node.onShift === false ? <span className="hq-org-badge">Off shift</span> : null}
          {node.whatsappConnected ? <span className="hq-org-badge wa">WhatsApp</span> : null}
          {node.kind === "manual" ? <span className="hq-org-badge muted">Not on Nexus</span> : null}
          {node.kind === "vacancy" ? <span className="hq-org-badge hiring">Open role</span> : null}
        </div>
      </div>
      {editing && node.kind !== "owner" ? (
        <div className="hq-org-edit">
          <label>Reports to
            <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
              {managerOptions(root, node).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>Department<input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Sales, Legal…" /></label>
          <div className="hq-org-edit-actions">
            <button type="button" className="btn" onClick={save}>Save</button>
            {node.kind !== "staff" ? <button type="button" className="btn ghost danger" onClick={remove}>Remove</button> : null}
          </div>
          {msg ? <p className="hq-org-msg">{msg}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Branch({ node, editing, root, slug, onChanged }: { node: HqOrgNode; editing: boolean; root: HqOrgNode; slug: string; onChanged: () => void }) {
  return (
    <li>
      <Card node={node} editing={editing} root={root} slug={slug} onChanged={onChanged} />
      {node.children.length ? (
        <ul>
          {node.children.map((child) => <Branch key={child.id} node={child} editing={editing} root={root} slug={slug} onChanged={onChanged} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function OrgChartView({ slug, chart, onChanged }: { slug: string; chart: HqOrgChart; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ kind: "manual" | "vacancy"; fullName: string; jobTitle: string; department: string; reportsTo: string } | null>(null);
  const [msg, setMsg] = useState("");
  const everyone = managerOptions(chart.root, { id: "__none__" } as HqOrgNode);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setMsg("");
    try {
      await addHqOrgMember(slug, { ...draft, fullName: draft.fullName || undefined, jobTitle: draft.jobTitle || undefined, department: draft.department || undefined });
      setDraft(null);
      onChanged();
    } catch (err) {
      setMsg(readableError(err));
    }
  }

  return (
    <section className="hq-org">
      <div className="hq-org-head">
        <p className="hq-org-summary">
          {plural(chart.headcount, "person", "people")}
          {chart.vacancies ? ` · ${plural(chart.vacancies, "open role", "open roles")}` : ""}
          {chart.departments.length ? ` · ${chart.departments.join(", ")}` : ""}
        </p>
        <button type="button" className={`btn ${editing ? "" : "ghost"}`} onClick={() => setEditing((v) => !v)}>
          {editing ? "Done editing" : "Edit structure"}
        </button>
      </div>

      <div className="hq-org-scroll">
        <ul className="hq-org-tree">
          <Branch node={chart.root} editing={editing} root={chart.root} slug={slug} onChanged={onChanged} />
        </ul>
      </div>
      {chart.root.children.length === 0 ? <p className="hq-empty hq-org-empty">No team yet — add the first person.</p> : null}

      {draft ? (
        <form className="hq-form" onSubmit={add}>
          <h4>{draft.kind === "vacancy" ? "Add an open role" : "Add a person not on Nexus"}</h4>
          <div className="hq-form-grid">
            {draft.kind === "manual" ? (
              <label>Name<input required value={draft.fullName} onChange={(e) => setDraft({ ...draft, fullName: e.target.value })} /></label>
            ) : null}
            <label>{draft.kind === "vacancy" ? "Role" : "Job title"}<input required={draft.kind === "vacancy"} value={draft.jobTitle} onChange={(e) => setDraft({ ...draft, jobTitle: e.target.value })} /></label>
            <label>Department<input value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })} /></label>
            <label>Reports to
              <select value={draft.reportsTo} onChange={(e) => setDraft({ ...draft, reportsTo: e.target.value })}>
                {everyone.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          </div>
          <div className="hq-form-actions">
            <button type="submit" className="btn">Add to chart</button>
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
            {msg ? <span className="hq-muted">{msg}</span> : null}
          </div>
        </form>
      ) : (
        <div className="hq-org-add">
          <button type="button" className="btn ghost" onClick={() => setDraft({ kind: "manual", fullName: "", jobTitle: "", department: "", reportsTo: "owner" })}>+ Add a person</button>
          <button type="button" className="btn ghost" onClick={() => setDraft({ kind: "vacancy", fullName: "", jobTitle: "", department: "", reportsTo: "owner" })}>+ Add an open role</button>
          <span className="hq-muted">Nexus staff join the chart on their own when they are added in Team.</span>
        </div>
      )}
    </section>
  );
}

/** The whole group: the owner, and every company under him. */
export function HqGroupChart({ group }: { group: HqGroupView }) {
  return (
    <section className="hq-group" aria-label="Group structure">
      <div className="hq-org-scroll">
        <ul className="hq-org-tree">
          <li>
            <div className="hq-org-card owner">
              <div className="hq-org-avatar" aria-hidden>{initials(group.owner.name)}</div>
              <div className="hq-org-who">
                <strong>{group.owner.name}</strong>
                <span className="hq-org-title">Owner of {plural(group.companies.length, "company", "companies")}</span>
              </div>
            </div>
            <ul>
              {group.companies.map((co) => (
                <li key={co.slug}>
                  <a className="hq-org-card company" href={`/deck/hq/${co.slug}#team`}>
                    <div className="hq-org-avatar" aria-hidden>{co.logoUrl ? <img src={co.logoUrl} alt="" /> : initials(co.name)}</div>
                    <div className="hq-org-who">
                      <strong>{co.name}</strong>
                      <span className="hq-org-title">
                        {co.headcount ? plural(co.headcount, "person", "people") : "No team yet"}
                        {co.vacancies ? ` · ${plural(co.vacancies, "open role", "open roles")}` : ""}
                      </span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          </li>
        </ul>
      </div>
    </section>
  );
}
