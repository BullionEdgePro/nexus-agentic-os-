# Focus workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the staff inbox into the Focus workspace: queue, snooze, shortcuts, Copilot, team dock, phone layout.

**Architecture:** Additive changes to the existing inbox, store and API; one migration (102); one shared team-thread hook.

**Tech Stack:** Next.js app router, Hono, Postgres, node:test.

**Spec:** `docs/superpowers/specs/2026-10-24-focus-workspace-design.md`

## Global Constraints

- Nothing the inbox does today stops working; admin layout unchanged.
- Calm tokens from deck.css only (no invented custom properties).
- No model call without a tap.
- Shortcuts never fire while typing in an input, textarea or contenteditable.

## Review Focus

- A snoozed chat whose customer writes again must count as waiting at once → Task 1 test.
- A snooze time in the past or > 30 days → 400 → Task 1 test.
- `E`/`X` pressed while typing a reply must not resolve the chat → Task 3 test.
- A swipe that travels < 96px does nothing → Task 6 test.
- The dock and the Team chat page must not each send a message twice → Task 5 test (shared hook, one clientId).

---

### Task 1: Snooze + queue data
Files: `packages/db/migrations/102-snooze.sql`, `packages/db/src/conversations.ts` (summary gains `snoozedUntil`, `snoozedAt`, `leadCategory`; `snoozeConversation`, `wakeConversation`), `packages/shared/src/types.ts`, `apps/api/src/routes/conversations.ts` (POST/DELETE `/:id/snooze`), waiting queries in `operators.ts`, `staff-work.ts`, `my-day.ts` gain `SNOOZED_SQL`. Test: `apps/api/test/a-snoozed-chat-waits-quietly.test.mjs`.

### Task 2: My queue
Files: `apps/web/app/inbox/page.tsx` (staff default folder "awaiting", oldest first, chips, reason tags, snooze menu + banner, folder `snoozed`), `apps/web/lib/store.ts` (`snooze`, `wake`), `apps/web/lib/api.ts`, `apps/web/lib/nav.tsx` (`staffLabel: "My queue"`), `apps/web/app/console-shell.tsx`, `apps/web/app/inbox/inbox.css`.

### Task 3: Shortcuts + command bar
Files: `apps/web/lib/command-actions.ts`, `apps/web/app/command-palette.tsx`, `apps/web/app/inbox/shortcuts.tsx` (hook + sheet), inbox wiring.

### Task 4: Copilot
Files: `apps/api/src/routes/conversations.ts` (suggest `style`), `apps/web/lib/api.ts`, `apps/web/app/inbox/copilot.tsx`, `details-panel.tsx`.

### Task 5: Team dock + typing
Files: `apps/web/lib/use-team-thread.ts` (extracted from the page), `apps/web/app/deck/team-chat/page.tsx` (uses it), `apps/web/app/inbox/team-dock.tsx`, `apps/api/src/routes/team-chat.ts` (`/threads/:id/typing`), `apps/api/src/lib/team-events.ts` (`team_typing`).

### Task 6: Phone
Files: `apps/web/app/mobile-tabs.tsx` + css, `console-shell.tsx`, swipe in the inbox list (`apps/web/app/inbox/swipe-row.tsx`).

### Task 7: Ship
Full check, migration 102 as owner after a backup, deploy, live-DB snooze check in a rolled-back transaction, on-screen check as Ralph.
