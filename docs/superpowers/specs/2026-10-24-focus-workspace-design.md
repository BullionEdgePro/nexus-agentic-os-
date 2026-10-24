# Focus workspace for staff — design

24 Oct 2026. Owner's words: "make the best ui/ux design of this platform, make it
more good rather than our competitors, make it perfect, be reliable, smart and
creative". Chosen in chat: compete with WhatsApp CRMs (respond.io, WATI,
Interakt, Zoko), support suites (Intercom, Zendesk), team chat (Slack, Teams)
and the best SaaS (Linear, Stripe); staff daily work first; direction "Focus
workspace". Mockups approved: https://claude.ai/artifact/G1ru18AVCPGHxdsv3UFWyE
("The mockups look good. Write the spec and plan, then build…").

## Principle

The Focus workspace is an upgrade of the existing inbox, not a second inbox.
Everything the inbox already does keeps working (AI suggest/polish, summary,
quick replies, 24-hour window handling, tags, tasks, calls, notes, privacy).
The calm palette stays. Admin screens are untouched except where shared.

## 1. My queue (staff)

- The sidebar says **My queue** for staff where it says Inbox for the admin
  (same page, `/inbox`; NavItem gains `staffLabel`).
- Staff open on the **Waiting** view, sorted **longest waiting first**.
- A chip row above the list for staff: **Waiting · Snoozed · Follow-ups · All
  mine**, each with its count; the folder column starts collapsed for staff
  (the existing collapse control still opens it).
- Each row shows a **reason tag** from the conversation's latest lead
  assessment: purchase_intent "Wants to buy", booking_intent "Booking",
  legal_inquiry "Legal question", complaint "Complaint", high_value "High
  value", inbound_pitch "Sales pitch". No assessment → no tag.
  `ConversationSummary.leadCategory: string | null`, read in the list query.

## 2. Snooze

- Migration 102: `conversations.snoozed_until timestamptz`,
  `snoozed_at timestamptz`, `snoozed_by text`.
- `POST /api/conversations/:id/snooze { until }` (ISO, 5 minutes to 30 days
  ahead) and `DELETE /api/conversations/:id/snooze`; behind the existing
  conversation guard, so staff snooze only their own chats.
- A conversation is **snoozed** while `snoozed_until > now()` AND the
  customer has not written since `snoozed_at`. Their next message wakes it.
  No background job: the rule is evaluated where it is read.
- Snoozed chats leave every waiting count (inbox Awaiting and SLA, the
  customer-waiting finding, Staff work, the staff home) and appear under
  **Snoozed**. When the time passes they are back in Waiting, at the top.
- Presets: 1 hour, 3 hours, Tomorrow 9:00, Next week (Monday 9:00), in the
  viewer's local time. The thread shows "Snoozed until <time> · Wake now".

## 3. Shortcuts and the command bar

- In the inbox, when focus is not in a text field: `J`/`K` next/previous
  chat, `R` reply box, `E` resolve, `S` snooze menu, `A` ask a colleague,
  `X` not a customer, `T` team chat dock, `?` the shortcut sheet,
  `Ctrl+Enter` send (also inside the reply box). Every shortcut is also a
  visible button.
- The command bar (Ctrl+K) shows **For this chat · <name>** first when a chat
  is open: Draft a reply, Resolve, Snooze 3 hours, Ask a colleague, Not a
  customer. Pages register these through `lib/command-actions.ts`
  (`setCommandActions(title, actions)` / `useCommandActions()`).

## 4. Copilot

A **Copilot** block at the top of the details panel:
- **What they want**: the existing summary, one tap, remembered for the chat
  while the page is open (a model call is never made without a tap).
- **Draft a reply**: the existing suggest endpoint, now with an optional
  `style`: `shorter` | `friendlier` | `formal` | `arabic`; the draft lands in
  the reply box, never sent by itself. Buttons: Draft, Shorter, Friendlier,
  Arabic.
- The rules the suggest prompt already keeps (no invented facts, prices,
  dates) hold for every style.

## 5. Team chat beside the work

- A **Team** button in the inbox header (and `T`) opens a dock on the right
  with the team room and each colleague as tabs; the details panel steps
  aside while it is open.
- The dock and the Team chat page share one hook, `useTeamThread`, so the
  reliability rules (saved first, one id per send, retry, re-read on
  reconnect, 15-second fallback) are written once.
- **Typing**: `POST /api/team-chat/threads/:id/typing` publishes
  `team_typing` (nothing stored); screens show "<name> is typing" for 5
  seconds; a screen sends it at most once every 3 seconds.

## 6. Phone

- Under 760px, staff get a bottom tab bar: **Queue** (`/inbox`), **Team**
  (`/deck/team-chat`, badge), **Follow-ups** (`/deck/tasks`), **Me** (`/`).
  Targets ≥ 44px.
- In the queue list, swipe a row right → resolve, left → snooze 3 hours; the
  row follows the finger, an action needs 96px of travel, and an **Undo**
  toast stays 6 seconds.

## Out of scope

Shopify order card (needs a store connection; separate piece), admin
dashboards, typing in customer chats, push notifications.

## Testing

Source-assertion tests per section (the repo's pattern); the snooze rule tested
against the live database in a rolled-back transaction; full `check.sh`;
on-screen check as Ralph (queue, chips, snooze, shortcuts, copilot, dock,
phone width).
