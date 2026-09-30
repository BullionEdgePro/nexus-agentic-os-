// The after-hours sweep and the "a chat is now yours" alert. Pinned as text,
// like the rest of the pipeline suite: what matters is which chats the sweep
// may hand out, that it reuses the live picker rather than a second copy, and
// that the alert can never hold up or undo an assignment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");

const AVAIL = read("apps", "api", "src", "services", "availability.ts");
const INBOX = read("packages", "db", "src", "inbox.ts");
const OPS = read("apps", "api", "src", "queue", "operators-processor.ts");
const ALERT = read("apps", "api", "src", "services", "assignment-alert.ts");
const ROUTE = read("apps", "api", "src", "routes", "employees.ts");
const SHELL = read("apps", "web", "app", "console-shell.tsx");
const LISTENER = read("apps", "web", "app", "assignment-alerts.tsx");
const TYPES = read("packages", "shared", "src", "types.ts");

const list = INBOX.slice(INBOX.indexOf("export async function listChatsWaitingForAssignee"));
const sweep = AVAIL.slice(AVAIL.indexOf("export async function assignWaitingChats"));

test("the sweep only offers chats that are genuinely waiting for a person", () => {
  const sql = list.slice(0, list.indexOf("return rows"));
  assert.match(sql, /where o\.auto_assign/, "only businesses that turned auto-assign on");
  assert.match(sql, /c\.employee_id is null/);
  // A handed-over chat with no owner is included — that customer was promised
  // a person — and stays eligible for 30 days, handed out first.
  assert.ok(!/not c\.is_human_handoff/.test(sql));
  assert.match(sql, /or \(c\.is_human_handoff and li\.last_in > now\(\) - interval '30 days'\)/);
  assert.match(sql, /order by c\.is_human_handoff desc, li\.last_in asc/);
  assert.match(sql, /c\.status in \('open', 'pending'\)/);
  assert.match(sql, /c\.channel = 'whatsapp'/);
  assert.match(sql, /now\(\) - interval '7 days'/, "a month-old thread is not dropped on the morning shift");
  assert.match(sql, /li\.last_in asc/, "the longest wait is handed out first");
  // Judged by the SERVING business on a shared number, not the number's owner.
  assert.match(sql, /coalesce\(c\.routed_organization_id, c\.organization_id\)/);
});

test("the sweep reuses the live picker, cross-tenant, and never throws", () => {
  assert.match(sweep, /withAllTenants\(/);
  assert.match(sweep, /await autoAssignIfEnabled\(chat\.servingOrganizationId, chat\.conversationId\)/);
  assert.match(sweep, /catch \(err\)/);
  // No second eligibility rule to drift out of step with the live one.
  assert.ok(!/resolvePresence|twinEnabled/.test(sweep));
});

test("it rides on the 10-minute operators job, after the operators run", () => {
  const body = OPS.slice(OPS.indexOf("async function processOperatorsJobBody"));
  assert.ok(body.indexOf("await runOperators()") < body.indexOf("await assignWaitingChats()"));
});

test("every assignment tells the person — auto and by hand, but not self-assigns", () => {
  assert.match(AVAIL, /alertAssignee\(\{ conversationId, employeeId: pick\.id, assignedBy: "Auto-assign" \}\)/);
  const assign = ROUTE.slice(ROUTE.indexOf('conversationAssignmentRoute.post("/:conversationId/assign"'));
  const tail = assign.slice(0, assign.indexOf("return c.json({ conversationId, employeeId })"));
  assert.match(tail, /if \(employeeId && employeeId !== actor\.id\)/);
  assert.match(tail, /alertAssignee\(/);
});

test("the alert leaves the caller's transaction and re-checks before speaking", () => {
  const fire = ALERT.slice(ALERT.indexOf("export function alertAssignee"));
  assert.match(fire, /setTimeout\(/);
  assert.match(fire, /withoutTenant\(\(\) =>\s*withAllTenants\(/, "own connection, not the reply pipeline's");
  assert.match(fire, /\.catch\(/, "never throws into the caller");
  const send = ALERT.slice(ALERT.indexOf("async function sendAlerts"));
  assert.match(send, /!context\.stillTheirs/, "reassigned in the meantime — say nothing");
  assert.match(send, /type: "assigned"/);
});

test("the phone alert needs an approved template and is throttled per person", () => {
  const send = ALERT.slice(ALERT.indexOf("async function sendAlerts"));
  assert.match(send, /findApprovedTemplateByName\(context\.ownerOrganizationId, ASSIGNED_TEMPLATE_NAME\)/);
  assert.match(send, /if \(!template\) return;/);
  assert.match(send, /PHONE_ALERT_GAP_MS/);
  assert.match(INBOX, /meta_template_name = \$2 and is_approved/);
});

test("staff screens listen, and only for alerts naming them", () => {
  assert.match(TYPES, /"status_changed" \| "assigned"/);
  assert.match(SHELL, /role === "employee" && me \? \(\s*<AssignmentAlerts/);
  assert.match(LISTENER, /parsed\.type !== "assigned" \|\| parsed\.employeeId !== employeeId/);
  // Desktop permission is asked for from a click, never on page load.
  assert.ok(!/useEffect\([^]*?requestPermission/.test(LISTENER.slice(0, LISTENER.indexOf("if (alerts.length === 0)"))));
});
