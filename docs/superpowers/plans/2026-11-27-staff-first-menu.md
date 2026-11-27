# Staff-first compact Nexus (piece 6): the staff menu and the phone tab bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The staff menu fits a 768px laptop, the phone Menu reads like the rail, and every tab says where it goes.

**Architecture:** `STAFF_MORE_GROUPS`, `railSections` and `moreStartsOpen` in `lib/nav.tsx`; `RailLinks` (app/console-shell.tsx) renders main sections then a More fold; `PhoneMenu` groups with the same function; CSS in console-shell.css and phone-menu.css; the tab label in mobile-tabs.tsx.

**Tech Stack:** React 18 client components, CSS, node:test.

**Spec:** docs/superpowers/specs/2026-11-27-staff-first-menu-design.md

## Global Constraints
- No door removed or hidden from anyone who has it; `visibleNav` stays the one list.
- `localStorage` only inside try/catch; the rail renders correctly without it.
- The existing tests (a-phone-reaches-every-door, the-dock-icons-are-glass-tiles) stay green.
- Tests: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/the-staff-first-menu.test.mjs`; suite `node test/run.mjs`; typecheck `npm run typecheck -w apps/web`.

## Review Focus
1. Staff on a More page (e.g. /deck/knowledge) — the fold is open on arrival and the door is marked current. (Pin: `moreStartsOpen`.)
2. Storage blocked (private window) — the rail still renders, More closed. (Pin: try/catch.)
3. A NAV entry in no group still renders (RailLinks' fallback stays). (Pin.)
4. Phone Menu above the tab bar — nothing covered. (CSS pin + preview.)
5. Admin rail — no fold, all sections. (Pin: operator `more` empty.)

---

### Task 1: the sections and the staff More fold
**Files:** `lib/nav.tsx`, `app/console-shell.tsx`, `app/console-shell.css`; Test `test/the-staff-first-menu.test.mjs` (new).
**Produces:** `STAFF_MORE_GROUPS: string[]`; `railSections<T extends { href: string }>(items: T[], role: "operator" | "employee"): { main: { title: string; items: T[] }[]; more: { title: string; items: T[] }[] }`; `moreStartsOpen(more, current: string): boolean`.
- [ ] Failing tests: staff split (main = Home/Work/People, more = AI agent/Insights/You), operator `more` empty, empty sections dropped, ungrouped items appended to main; `moreStartsOpen` true only when current is in more. RailLinks source: `railSections(visible, role)`, `<button type="button" className="rail-more" aria-expanded=`, `try {` around `localStorage`, `moreStartsOpen(`. CSS: link padding `5px 12px`, tile `28px`, `.rail-group` padding `9px 12px 3px`.
- [ ] Run → FAIL; implement; run → PASS; commit `feat(menu): staff daily doors in view; the rest under More; tighter rows`.

### Task 2: the phone Menu and the Today tab
**Files:** `app/phone-menu.tsx`, `app/phone-menu.css`, `app/mobile-tabs.tsx`, `app/console-shell.tsx` (PhoneMenu props); the test file.
- [ ] Failing tests: PhoneMenu uses `railSections(items, "employee")`, renders a heading per section (`className="pmenu-group"`) and `<span className="rail-icon" data-tone={toneOf(item.href)}>`; CSS `.pmenu-links { … grid-template-columns: 1fr 1fr` and `.pmenu-backdrop { … z-index:` above `.mtabs`; mobile-tabs has `label: "Today"` and no `label: "Me"`.
- [ ] Run → FAIL; implement; run → PASS; suite + typecheck; commit `feat(menu): the phone Menu reads like the rail; the home tab says Today`.
