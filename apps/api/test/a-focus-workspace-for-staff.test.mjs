// The Focus workspace for staff (24 Oct 2026). Owner: "make the best ui/ux
// design of this platform ... better than our competitors ... reliable, smart
// and creative". Mockups approved; spec:
// docs/superpowers/specs/2026-10-24-focus-workspace-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const INBOX = () => read("apps", "web", "app", "inbox", "page.tsx");

// ---- §1 My queue -------------------------------------------------------------

test("staff land on their queue: waiting, longest waiting first", () => {
  const src = INBOX();
  const from = src.indexOf("if (myEmployeeId) {");
  assert.ok(from >= 0, "the staff landing exists");
  const landing = src.slice(from, from + 400);
  assert.match(landing, /setFolder\("awaiting"\)/);
  assert.match(landing, /setOldestFirst\(true\)/);
  assert.match(src, /\["awaiting", "Waiting"\]/);
  assert.match(src, /\["snoozed", "Snoozed"\]/);
  assert.match(read("apps", "web", "lib", "nav.tsx"), /staffLabel: "My queue"/);
});

test("each chat says why it matters", () => {
  const src = INBOX();
  for (const label of ["Wants to buy", "High value", "Complaint", "Sales pitch"]) assert.match(src, new RegExp(label));
});

// ---- §3 Shortcuts and the command bar ---------------------------------------

test("a shortcut never fires while somebody is typing", () => {
  const KEYS = read("apps", "web", "app", "inbox", "shortcuts.tsx");
  assert.match(KEYS, /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/);
  assert.match(KEYS, /isContentEditable/);
  assert.match(KEYS, /if \(isTypingTarget\(event\.target\)\) return;/);
  assert.match(KEYS, /event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey/);
});

test("every shortcut is wired, and listed on the sheet", () => {
  const src = INBOX();
  for (const key of ["j:", "k:", "r:", "e:", "s:", "a:", "x:", '"?":']) assert.ok(src.includes(`    ${key}`), key);
  const KEYS = read("apps", "web", "app", "inbox", "shortcuts.tsx");
  for (const row of ["Resolve", "Snooze", "Ask a colleague", "Not a customer", "Team chat"]) assert.match(KEYS, new RegExp(row));
});

test("the command bar offers the open chat's actions first, and clears them when it closes", () => {
  const PALETTE = read("apps", "web", "app", "command-palette.tsx");
  assert.match(PALETTE, /\[\.\.\.actionHits, \.\.\.screenHits, \.\.\.clientHits\]/);
  const src = INBOX();
  assert.match(src, /setCommandActions\(`For this chat · \$\{name\}`/);
  assert.match(src, /useEffect\(\(\) => \(\) => clearCommandActions\(\), \[\]\)/);
});

// ---- §4 Copilot --------------------------------------------------------------

test("a draft's style changes the voice or language, never the no-invented-facts rule", () => {
  const CONVERSATIONS = read("apps", "api", "src", "routes", "conversations.ts");
  const at = CONVERSATIONS.indexOf('conversationsRoute.post("/:id/suggest"');
  assert.ok(at >= 0, "the suggest route exists");
  const body = CONVERSATIONS.slice(at, CONVERSATIONS.indexOf("\n});", at));
  assert.match(body, /NEVER invent facts, prices, availability, dates or promises/);
  assert.match(body, /\(style \? ` \$\{DRAFT_STYLES\[style\]\}` : ""\)/);
  assert.match(body, /body\.style in DRAFT_STYLES/);
  for (const style of ["shorter", "friendlier", "formal", "arabic"]) assert.match(CONVERSATIONS, new RegExp(`  ${style}: "`));
});

test("Copilot never sends: a draft goes to the reply box, and nothing runs without a tap", () => {
  const COPILOT = read("apps", "web", "app", "inbox", "copilot.tsx");
  assert.match(COPILOT, /onDraft\(suggestion\)/);
  assert.doesNotMatch(COPILOT, /sendMessage|useEffect/);
  assert.match(INBOX(), /<Copilot key=\{`copilot-\$\{activeConversation\.id\}`\} conversationId=\{activeConversation\.id\} onDraft=\{setDraft\} \/>/);
});

// ---- §5 Team chat beside the work -------------------------------------------

test("the dock and the page share one thread hook, so a message is never sent twice", () => {
  const DOCK = read("apps", "web", "app", "inbox", "team-dock.tsx");
  const PAGE = read("apps", "web", "app", "deck", "team-chat", "page.tsx");
  for (const src of [DOCK, PAGE]) {
    assert.match(src, /useTeamThread\(/);
    assert.match(src, /<ThreadMessages/);
    assert.match(src, /15_000/);
    assert.doesNotMatch(src, /sendTeamMessage\(/, "sending lives in the hook only");
  }
  assert.match(INBOX(), /teamOpen \? \(\s*<TeamDock/);
});

test("typing: nothing stored, only from someone who may write, and throttled", () => {
  const TEAM_ROUTE = read("apps", "api", "src", "routes", "team-chat.ts");
  const at = TEAM_ROUTE.indexOf('teamChatRoute.post("/threads/:id/typing"');
  assert.ok(at >= 0, "the typing route exists");
  const body = TEAM_ROUTE.slice(at, TEAM_ROUTE.indexOf("\n});", at));
  assert.match(body, /teamAccess\(thread, who\.viewer\)\.post/);
  assert.doesNotMatch(body, /postTeamMessage|withTenant/);
  const HOOK = read("apps", "web", "lib", "use-team-thread.ts");
  assert.match(HOOK, /TYPING_SENT_EVERY_MS = 3_000/);
  assert.match(HOOK, /TYPING_SHOWN_MS = 5_000/);
  assert.match(read("apps", "web", "app", "team-chat-alerts.tsx"), /if \(event\.type === "team_typing"\) return;/);
});

// ---- §6 Phone ----------------------------------------------------------------

test("a swipe needs a finger and 96px, never fires on a scroll, and can be undone", () => {
  const SWIPE = read("apps", "web", "app", "inbox", "swipe-row.tsx");
  assert.match(SWIPE, /SWIPE_ACTION_PX = 96/);
  assert.match(SWIPE, /if \(e\.pointerType !== "touch"\) return;/);
  assert.match(SWIPE, /horizontal\.current = Math\.abs\(x\) > Math\.abs\(y\)/);
  assert.match(SWIPE, /onClickCapture/);
  const src = INBOX();
  assert.match(src, /setTimeout\(\(\) => setUndo\(null\), 6_000\)/);
  assert.match(src, /run: \(\) => void setStatus\(conversation\.id, "open"\)/);
  assert.match(src, /run: \(\) => void setSnooze\(conversation\.id, null\)/);
});

test("staff get Queue, Team, Follow-ups and Me at the bottom of a phone", () => {
  const TABS = read("apps", "web", "app", "mobile-tabs.tsx");
  for (const label of ["Queue", "Team", "Follow-ups", "Me"]) assert.match(TABS, new RegExp(`label: "${label}"`));
  assert.match(read("apps", "web", "app", "mobile-tabs.css"), /@media \(max-width: 759px\)/);
  assert.match(read("apps", "web", "app", "console-shell.tsx"), /role === "employee" \? <MobileTabs \/> : null/);
});

test("nothing pinned to the bottom of a phone covers the tabs", () => {
  const css = read("apps", "web", "app", "mobile-tabs.css");
  const phone = css.slice(css.indexOf("@media (max-width: 759px)"));
  for (const pinned of [".as-open", ".as ", ".asg-stack", ".ibx-offline", ".ibx-undo", ".tc-toast"]) {
    const at = phone.indexOf(pinned);
    assert.ok(at >= 0, `${pinned} is lifted on a phone`);
    assert.match(phone.slice(at, phone.indexOf("}", at)), /bottom: calc\(var\(--mtabs-h\)/);
  }
});
