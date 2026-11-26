# Staff-first compact Nexus (piece 3): chat header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a phone, an open chat's header is one row (back, customer, Call, Resolve, AI switch, ⋯); ⋯ shows the rest and the labels.

**Architecture:** One `moreOpen` state and a `more-open` class on `header.ibx-thread-head` in `apps/web/app/inbox/page.tsx`; phone-only CSS in `apps/web/app/inbox/inbox.css` hides the secondary controls and the label row unless `more-open`.

**Tech Stack:** Next.js 14 client page, CSS, node:test (source and CSS pins).

**Spec:** docs/superpowers/specs/2026-11-26-staff-first-chat-header-design.md

## Global Constraints
- Phone (≤760px) only; wider screens unchanged; ⋯ hidden there.
- No control removed; keyboard shortcuts and the command palette untouched.
- LF files; Edit/Write only. Test: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/the-staff-first-chat-header.test.mjs`; suite `node test/run.mjs`; typecheck `npm run typecheck -w apps/web`.

## Review Focus
1. Another chat opened while ⋯ is open — it starts folded. (Pin: reset on `activeConversation?.id`.)
2. A long customer name — truncates; Call/Resolve/switch/⋯ stay on the row. (Hand check at 375px.)
3. Snooze or Ask a colleague opened from the ⋯ row — their popovers still open. (Hand check.)
4. Not a customer already on ("Not a customer · Undo") — still reachable under ⋯. (Pin: the rule hides by class, both states share `.ibx-notcust`.)
5. Laptop at 1024px — unchanged, no ⋯. (Pin: base `.ibx-more-btn { display: none; }`; hand check.)

---

### Task 1: the folding header
**Files:** Modify `apps/web/app/inbox/page.tsx` (header 1298-1435), `apps/web/app/inbox/inbox.css` (thread head 524-545; phone block); Test `apps/web/test/the-staff-first-chat-header.test.mjs` (new).

- [ ] **Step 1: failing tests** — page: `const [moreOpen, setMoreOpen] = useState(false)`; an effect `setMoreOpen(false)` on `[activeConversation?.id]`; `className={\`ibx-thread-head${moreOpen ? " more-open" : ""}\`}`; the details button carries `ibx-head-details`; a `ibx-more-btn` button with `aria-expanded={moreOpen}` and `aria-controls`. CSS: base `.ibx-more-btn { display: none; }`; in the 760px block `.ibx-more-btn { display: inline-grid; }`, `.ibx-thread-head:not(.more-open) :is(.ibx-head-details, .ibx-assignee, .ibx-snooze, .ibx-notcust, .ibx-ask) { display: none; }`, `.ibx-thread-head:not(.more-open) + .ibx-thread-tags { display: none; }`, `.ibx-thread-head.more-open .ibx-head-actions { flex: 1 1 100%;`.
- [ ] **Step 2: run** — FAIL. **Step 3: implement.** **Step 4: run** file, suite, typecheck — PASS. **Step 5: commit** `feat(inbox): on a phone an open chat's header is one row; ⋯ shows the rest`.
