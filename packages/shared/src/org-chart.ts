/**
 * Business HQ organizational charts (owner-approved 14 Oct 2026).
 *
 * Pure: the API hands over the company's active Nexus staff and the chart
 * details an admin set (reports-to, department, people not on Nexus,
 * vacancies), and this builds the tree. The owner of every company sits on
 * top. Nothing an admin set can make a person vanish: a reporting line that
 * points at someone gone climbs to that person's own manager, and anything
 * that cannot reach the top (a stale loop) hangs from the owner.
 *
 * Node ids: "owner", "e:<employeeId>" for Nexus staff, "m:<memberId>" for
 * people added by hand and vacancies. `reportsTo` holds one of those ids.
 */
export type OrgNodeKind = "owner" | "staff" | "manual" | "vacancy";

export interface OrgStaffInput {
  id: string;
  fullName: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  onShift: boolean;
  whatsappConnected: boolean;
}

export interface OrgMemberInput {
  id: string;
  kind: "staff" | "manual" | "vacancy";
  /** Set for kind "staff": the Nexus employee this row adds detail to. */
  employeeId: string | null;
  fullName: string | null;
  jobTitle: string | null;
  department: string | null;
  reportsTo: string | null;
}

export interface OrgNode {
  id: string;
  kind: OrgNodeKind;
  name: string;
  title: string | null;
  department: string | null;
  avatarUrl: string | null;
  onShift: boolean | null;
  whatsappConnected: boolean | null;
  /** True for people with a Nexus login. */
  onNexus: boolean;
  /** The hq_org_members row behind this node, when there is one. */
  memberId: string | null;
  children: OrgNode[];
}

export interface OrgChart {
  root: OrgNode;
  /** People, not counting the owner or vacancies. */
  headcount: number;
  vacancies: number;
  departments: string[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function buildOrgChart(input: {
  owner: { name: string; title: string | null };
  companyCount: number;
  staff: OrgStaffInput[];
  members: OrgMemberInput[];
}): OrgChart {
  const root: OrgNode = {
    id: "owner",
    kind: "owner",
    name: input.owner.name,
    title: input.companyCount > 1 ? `Owner of all ${input.companyCount} companies` : input.owner.title ?? "Owner",
    department: null,
    avatarUrl: null,
    onShift: null,
    whatsappConnected: null,
    onNexus: false,
    memberId: null,
    children: [],
  };

  const overlay = new Map(input.members.filter((m) => m.kind === "staff" && m.employeeId).map((m) => [m.employeeId!, m]));
  const memberById = new Map(input.members.map((m) => [m.id, m]));

  // Every reporting line an admin ever set, including those of people now
  // gone, so a line through a departed manager can climb past them.
  const rawParent = (id: string): string | null => {
    if (id.startsWith("e:")) return overlay.get(id.slice(2))?.reportsTo ?? null;
    if (id.startsWith("m:")) return memberById.get(id.slice(2))?.reportsTo ?? null;
    return null;
  };

  const nodes = new Map<string, OrgNode>();
  for (const s of input.staff) {
    if (!s.isActive) continue;
    // The owner's own staff account IS the owner card: his live status rides
    // on it instead of a second "Atif" appearing under himself.
    if (norm(s.fullName) === norm(input.owner.name)) {
      root.onShift = s.onShift;
      root.whatsappConnected = s.whatsappConnected;
      root.avatarUrl = s.avatarUrl;
      root.onNexus = true;
      continue;
    }
    const detail = overlay.get(s.id);
    nodes.set(`e:${s.id}`, {
      id: `e:${s.id}`,
      kind: "staff",
      name: s.fullName,
      title: s.jobTitle,
      department: detail?.department ?? null,
      avatarUrl: s.avatarUrl,
      onShift: s.onShift,
      whatsappConnected: s.whatsappConnected,
      onNexus: true,
      memberId: detail?.id ?? null,
      children: [],
    });
  }
  for (const m of input.members) {
    if (m.kind === "staff") continue;
    nodes.set(`m:${m.id}`, {
      id: `m:${m.id}`,
      kind: m.kind,
      name: m.kind === "vacancy" ? `Hiring: ${m.jobTitle ?? "Open role"}` : m.fullName ?? "Unnamed",
      title: m.kind === "vacancy" ? null : m.jobTitle,
      department: m.department,
      avatarUrl: null,
      onShift: null,
      whatsappConnected: null,
      onNexus: false,
      memberId: m.id,
      children: [],
    });
  }

  // Resolve each visible parent: climb past anyone not on the chart; give up
  // to the owner on a dead end or a loop.
  const parentOf = new Map<string, string>();
  for (const id of nodes.keys()) {
    let p = rawParent(id);
    const seen = new Set<string>([id]);
    while (p && p !== "owner" && !nodes.has(p)) {
      if (seen.has(p)) { p = null; break; }
      seen.add(p);
      p = rawParent(p);
    }
    parentOf.set(id, p && p !== id && (p === "owner" || nodes.has(p)) ? p : "owner");
  }
  // A loop among visible people (data written before loops were refused)
  // cannot reach the top; those hang from the owner instead.
  for (const id of nodes.keys()) {
    const seen = new Set<string>();
    let p: string | undefined = id;
    while (p && p !== "owner" && !seen.has(p)) {
      seen.add(p);
      p = parentOf.get(p);
    }
    if (p !== "owner") parentOf.set(id, "owner");
  }

  for (const [id, node] of nodes) {
    const parent = parentOf.get(id)!;
    (parent === "owner" ? root : nodes.get(parent)!).children.push(node);
  }
  const order: Record<OrgNodeKind, number> = { owner: 0, staff: 1, manual: 1, vacancy: 2 };
  const sortTree = (n: OrgNode) => {
    n.children.sort((a, b) => order[a.kind] - order[b.kind] || (a.department ?? "~").localeCompare(b.department ?? "~") || a.name.localeCompare(b.name));
    n.children.forEach(sortTree);
  };
  sortTree(root);

  const all = [...nodes.values()];
  return {
    root,
    headcount: all.filter((n) => n.kind !== "vacancy").length,
    vacancies: all.filter((n) => n.kind === "vacancy").length,
    departments: [...new Set(all.map((n) => n.department).filter((d): d is string => !!d))].sort(),
  };
}

/**
 * Would putting `childId` under `newParentId` make someone report, through the
 * chain, to themselves? Checked before a reporting line is saved.
 */
export function wouldCreateLoop(members: OrgMemberInput[], childId: string, newParentId: string): boolean {
  if (childId === newParentId) return true;
  const current = new Map<string, string | null>();
  for (const m of members) {
    const id = m.kind === "staff" && m.employeeId ? `e:${m.employeeId}` : `m:${m.id}`;
    current.set(id, m.reportsTo);
  }
  current.set(childId, newParentId);
  let p: string | null | undefined = newParentId;
  const seen = new Set<string>();
  while (p && p !== "owner") {
    if (p === childId) return true;
    if (seen.has(p)) return true;
    seen.add(p);
    p = current.get(p);
  }
  return false;
}
