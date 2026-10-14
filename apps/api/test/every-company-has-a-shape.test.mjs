// Every company has a shape (Business HQ org charts, owner-approved 14 Oct 2026).
// One pure builder decides the tree; these run it for real. The owner of all
// five companies sits on top of every chart. Nexus staff appear automatically;
// an admin adds who reports to whom, departments, people not on Nexus and open
// vacancies. A deactivated manager's people move up a level, and a reporting
// loop is refused before it is ever saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrgChart, wouldCreateLoop } from "@nexus/shared";

const OWNER = { name: "Atif Ali Ali Said", title: "Owner" };
const staff = (id, name, title, over = {}) => ({ id, fullName: name, jobTitle: title, avatarUrl: null, isActive: true, onShift: false, whatsappConnected: true, ...over });
const member = (id, kind, over = {}) => ({ id, kind, employeeId: null, fullName: null, jobTitle: null, department: null, reportsTo: null, ...over });

/** name -> parent name, flattened from the tree, for readable assertions. */
function edges(node, parent = null, out = {}) {
  out[node.name] = parent;
  for (const child of node.children) edges(child, node.name, out);
  return out;
}

test("the owner is on top, and staff with no manager set report to him", () => {
  const chart = buildOrgChart({ owner: OWNER, companyCount: 5, staff: [staff("e1", "Abdul Basit", "Agent"), staff("e2", "Aqib Sarosh", "Operations")], members: [] });
  assert.equal(chart.root.kind, "owner");
  assert.equal(chart.root.name, "Atif Ali Ali Said");
  assert.equal(chart.root.title, "Owner of all 5 companies");
  assert.deepEqual(edges(chart.root), { "Atif Ali Ali Said": null, "Abdul Basit": "Atif Ali Ali Said", "Aqib Sarosh": "Atif Ali Ali Said" });
  assert.equal(chart.headcount, 2);
});

test("reporting lines and departments set in HQ shape the tree", () => {
  const chart = buildOrgChart({
    owner: OWNER, companyCount: 5,
    staff: [staff("e1", "Abdul Basit", "Agent"), staff("e2", "Aqib Sarosh", "Operations"), staff("e3", "Rinal Bhoi", "Agent")],
    members: [
      member("m1", "staff", { employeeId: "e1", reportsTo: "e:e2", department: "Sales" }),
      member("m2", "staff", { employeeId: "e3", reportsTo: "e:e2", department: "Sales" }),
      member("m3", "manual", { fullName: "Sara K.", jobTitle: "Accountant", reportsTo: "owner", department: "Finance" }),
      member("m4", "vacancy", { jobTitle: "Marketing manager", reportsTo: "e:e2" }),
    ],
  });
  assert.deepEqual(edges(chart.root), {
    "Atif Ali Ali Said": null,
    "Aqib Sarosh": "Atif Ali Ali Said",
    "Abdul Basit": "Aqib Sarosh",
    "Rinal Bhoi": "Aqib Sarosh",
    "Hiring: Marketing manager": "Aqib Sarosh",
    "Sara K.": "Atif Ali Ali Said",
  });
  const sales = chart.root.children.find((n) => n.name === "Aqib Sarosh").children.find((n) => n.name === "Abdul Basit");
  assert.equal(sales.department, "Sales");
  assert.equal(chart.headcount, 4, "a vacancy is not a person");
  assert.equal(chart.vacancies, 1);
  assert.deepEqual(chart.departments, ["Finance", "Sales"]);
});

test("a deactivated manager's people move up to the manager's own manager", () => {
  const chart = buildOrgChart({
    owner: OWNER, companyCount: 5,
    staff: [staff("e1", "Abdul Basit", "Agent"), staff("e2", "Aqib Sarosh", "Operations", { isActive: false }), staff("e3", "Lead", "Team lead")],
    members: [member("m1", "staff", { employeeId: "e1", reportsTo: "e:e2" }), member("m2", "staff", { employeeId: "e2", reportsTo: "e:e3" })],
  });
  assert.deepEqual(edges(chart.root), { "Atif Ali Ali Said": null, Lead: "Atif Ali Ali Said", "Abdul Basit": "Lead" });
});

test("a line pointing at someone who is gone falls back to the owner", () => {
  const chart = buildOrgChart({ owner: OWNER, companyCount: 5, staff: [staff("e1", "Abdul Basit", "Agent")], members: [member("m1", "staff", { employeeId: "e1", reportsTo: "m:deleted" })] });
  assert.deepEqual(edges(chart.root), { "Atif Ali Ali Said": null, "Abdul Basit": "Atif Ali Ali Said" });
});

test("the owner's own staff account is the owner card, not a second person", () => {
  const chart = buildOrgChart({ owner: OWNER, companyCount: 5, staff: [staff("e9", "Atif Ali Ali Said", "Owner and Legal Counsel", { onShift: true })], members: [] });
  assert.deepEqual(edges(chart.root), { "Atif Ali Ali Said": null });
  assert.equal(chart.root.onShift, true, "his live status rides on the owner card");
  assert.equal(chart.headcount, 0);
});

test("a company with no team yet is the owner alone", () => {
  const chart = buildOrgChart({ owner: OWNER, companyCount: 5, staff: [], members: [] });
  assert.equal(chart.root.children.length, 0);
  assert.equal(chart.headcount, 0);
});

test("a reporting loop is refused before it is saved", () => {
  const members = [member("m1", "staff", { employeeId: "e1", reportsTo: "e:e2" }), member("m2", "staff", { employeeId: "e2", reportsTo: "e:e3" })];
  assert.equal(wouldCreateLoop(members, "e:e3", "e:e1"), true, "e3 under e1 closes e1->e2->e3->e1");
  assert.equal(wouldCreateLoop(members, "e:e1", "e:e1"), true, "nobody reports to themselves");
  assert.equal(wouldCreateLoop(members, "e:e3", "owner"), false);
  assert.equal(wouldCreateLoop(members, "e:e1", "e:e3"), false, "moving e1 under e3 is fine");
});
