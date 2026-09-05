// A picker whose choices the API refuses is not a feature, it is a trap.
//
// Manual assignment had a validated endpoint (POST /conversations/:id/assign)
// and a client call for months, with nothing in the inbox that used them. The
// gap was not the endpoint — it was that "Assigned to" was read-only text. This
// test pins the wiring that closed it, and the one subtlety that makes it
// correct rather than merely present.
//
// THE SUBTLETY: on the shared number a conversation is OWNED by the number's
// business but ROUTED to another, and the assign endpoint accepts only the
// SERVING business's active staff. The details panel's other rosters
// (collaborators) are the owner's. So the assignment picker needs its OWN
// roster, scoped to the serving org — offer the owner's staff on a routed
// conversation and every choice is a 400 rendered as "belongs to a different
// business".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
const EMP = read("apps", "api", "src", "routes", "employees.ts");
const PANEL = read("apps", "web", "app", "inbox", "details-panel.tsx");
const STORE = read("apps", "web", "lib", "store.ts");
const API = read("apps", "web", "lib", "api.ts");

test("the details endpoint offers an assignable roster scoped to the SERVING org", () => {
  const handler = ROUTE.slice(
    ROUTE.indexOf('conversationsRoute.get("/:id/details"'),
    ROUTE.indexOf('conversationsRoute.patch("/:id/collaborators"')
  );
  // It resolves the serving org from routing, falling back to the owner when
  // nothing routed the conversation.
  assert.match(handler, /getConversationRouting/);
  assert.match(handler, /routing\?\.routedOrganizationId \?\? details\.organizationId/);
  // And returns a distinct assignableTeam, not just `team`.
  assert.match(handler, /assignableTeam/);
  assert.match(handler, /return c\.json\(\{ details, collaborators, team, assignableTeam \}\)/);
});

test("the roster the picker shows is the exact set the assign endpoint accepts", () => {
  // The endpoint's rule: active staff of the SERVING org, or it 400s. If the two
  // ever drift, the picker offers choices the API rejects — so they are asserted
  // together, here, rather than trusted to stay in step.
  const assign = EMP.slice(EMP.indexOf('conversationAssignmentRoute.post("/:conversationId/assign"'));
  assert.match(assign, /resolveServingOrganizationId/);
  assert.match(assign, /belongs to a different business/);
  assert.match(assign, /no longer active/);

  // The details route builds assignableTeam from the serving org's ACTIVE staff,
  // the same two conditions.
  const handler = ROUTE.slice(
    ROUTE.indexOf('conversationsRoute.get("/:id/details"'),
    ROUTE.indexOf('conversationsRoute.patch("/:id/collaborators"')
  );
  assert.match(handler, /listOrgStaffNames\(servingOrgId\)[\s\S]{0,80}filter\(\(e\) => e\.isActive\)/);
});

test("the client carries assignableTeam through and can assign or hand back", () => {
  assert.match(API, /assignableTeam: StaffRef\[\]/);
  // null hands it back to nobody — the endpoint reads a non-string employeeId as
  // null, so the client must be able to send exactly that.
  assert.match(API, /export function assignConversation\(\s*conversationId: string,\s*employeeId: string \| null/);
  assert.match(API, /\/api\/conversations\/\$\{conversationId\}\/assign/);
});

test("reassigning moves the thread in the loaded list, so Mine keeps up", () => {
  // The 'Mine' folder and the folder counts read assignedEmployeeId off the
  // loaded summaries. Without this the summary would still say the old owner
  // until a full reload, and a thread just handed to you would not appear in
  // Mine.
  assert.match(STORE, /applyAssignment: \(conversationId, employeeId\) =>/);
  assert.match(STORE, /c\.id === conversationId \? \{ \.\.\.c, assignedEmployeeId: employeeId \} : c/);
  assert.match(PANEL, /applyAssignment = useInboxStore\(\(s\) => s\.applyAssignment\)/);
  assert.match(PANEL, /applyAssignment\(conversationId, employeeId\)/);
});

test("a change that did not save does not sit on screen as though it did", () => {
  // The assignment version of the send that silently failed: the box shows the
  // new owner, the API rejected it, and nobody knows. On failure both the panel
  // and the list go back to the previous assignee and the error is shown.
  const fn = PANEL.slice(PANEL.indexOf("async function assign("));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /const prevId = details\.assignedEmployeeId/);
  assert.match(body, /catch \(err\)/);
  assert.match(body, /assignedEmployeeId: prevId/);
  assert.match(body, /applyAssignment\(conversationId, prevId\)/);
  assert.match(body, /Could not change who this is assigned to/);
});

test("an off-roster current assignee stays visible rather than reading Unassigned", () => {
  // A conversation can carry an assignee who is now inactive, or who belonged to
  // the business before a routing change — absent from the serving-org list. The
  // select keeps them as an option so the box shows their name instead of
  // silently claiming the thread is unassigned.
  assert.match(
    PANEL,
    /details\.assignedEmployeeId && !assignable\.some\(\(t\) => t\.id === details\.assignedEmployeeId\)/
  );
});
