# Nexus on the Phone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Nexus installable on iPhone and Android, send private lock-screen alerts for a person's own chats, and offer an Android app download plus an iPhone install guide from the website.

**Architecture:** The existing Next.js 14 web app (`apps/web`) gains:
- a web manifest, a small service worker and phone-first inbox layouts;
- a web-push sender in the API worker that listens to the existing Redis inbox-event channel (`subscribeToInboxEvents`) and writes nothing into the reply path;
- a Bubblewrap Trusted Web Activity that wraps the same site as an Android APK, served from `/download`.

**Tech Stack:** Next.js 14 App Router, Hono API + BullMQ worker, Postgres with RLS, Redis pub/sub, `web-push` (VAPID), Bubblewrap CLI (JDK 17 + Android SDK), `qrcode` (server-side SVG).

**Spec:** `docs/superpowers/specs/2026-10-09-nexus-mobile-app-design.md`

## Global Constraints

- **Distribution:** from the Nexus website only. No App Store or Play Store artefacts.
- **iPhone:** installs via Safari Add to Home Screen. Push needs iOS 16.4 or newer AND the installed (standalone) app.
- **Canonical host:** `https://nexusagenticos.com` (www 301s to it). `app.nexusagenticos.com` also serves the app. The TWA and `assetlinks.json` target `nexusagenticos.com`.
- **Manifest values:** name "Nexus", short_name "Nexus", start_url `/inbox`, display `standalone`. Icons are 192 px and 512 px, plus a maskable 512 px.
- **Service worker:** never caches anything under `/api` or on `api.nexusagenticos.com`. The only precached file is `/offline.html`.
- **Phone breakpoint:** `max-width: 760px`. The desktop inbox layout and its existing layout tests are unchanged.
- **Notification copy:**
  - Title: `<Customer> · <Business>`.
  - Body: `sent a message` | `was assigned to you`, or the message text (at most 120 chars) ONLY when that device's `previews = true`.
  - Tag: `conv-<conversationId>`.
  - URL: `/inbox?c=<conversationId>`.
- **Defaults:** `previews` false and `mode` 'mine'. Mode values are exactly `'mine' | 'all' | 'paused'`.
- **Delivery bookkeeping:**
  - A 404 or 410 from the push service deletes the subscription.
  - Any other failure increments `failure_count`; 5 or more = broken.
  - Each send has a 10 s timeout.
- **Owner platform alerts:** at most 1 per problem per 6 h. Never for "no numbers connected yet".
- **Subject key:** a person is identified by `readerOf(scope)` from `apps/api/src/lib/actor.ts` (`e:<employeeId>` / `o:<adminId>`). Never take a subject from a request body.
- **Android:** package `com.nexusagenticos.app`, launcher name "Nexus".
  - Keystore at `mobile/android/nexus-release.keystore`, git-ignored; its password goes in git-ignored `mobile/android/.keystore-pass`.
  - APK served at `/download/nexus-<version>.apk`, and `/download/nexus.apk` = latest.
- **Process gates:**
  - Migrations run as the owner via psql (never `db:migrate`).
  - Every commit passes `bash scripts/check.sh`.
  - Deploy flow: commit → `bash scripts/mirror.sh` → `ssh root@200.141.5.204 'cd /opt/nexus && ./scripts/deploy.sh'`.
  - Run `sed -i 's/\r$//' apps/api/src/queue/processor.ts` before check.sh if git flips it to CRLF.
- **Owner approvals:** the owner approves the Bubblewrap/JDK/SDK download (about 1 GB) before Task 13, and chooses the keystore backup location.

## Review Focus

1. **iPhone user taps "Turn on" in a normal Safari tab** (not the installed app, where `Notification`/`PushManager` are absent). Expected: a plain "install Nexus to your Home Screen first" message, no crash. Test is in Task 11.
2. **The same phone subscribes twice** (reinstall, cleared site data, key refresh). Expected: one row (upsert on `endpoint`), one alert per event. Test is in Task 6.
3. **The assignee is deactivated, or the chat is reassigned.** Expected: the old or inactive person gets nothing; the new assignee does. Test is in Task 8.
4. **A notification tap opens `/inbox?c=<id>` for a chat the signed-in person cannot see** (other business, or signed in as someone else). Expected: the normal inbox list with no error and no leak of the chat. Test is in Task 4.
5. **Message text with markup, emoji or a very long body**, with previews on. Expected: plain text, at most 120 chars with an ellipsis, never HTML. Test is in Task 7.

---

## Phase 1 — Installable app + phone-first inbox

### Task 1: App identity (manifest, icons, iOS metadata)

**Files:**
- Create: `apps/web/app/manifest.ts`
- Create: `apps/web/public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (180×180)
- Create: `mobile/tools/make_icons.py` (dev-only generator; Pillow)
- Modify: `apps/web/app/layout.tsx` (metadata `appleWebApp`, `icons`; export `viewport` with `themeColor`)
- Test: `apps/api/test/nexus-installs-on-a-phone.test.mjs`

**Interfaces:**
- Produces: `/manifest.webmanifest` (served by Next from `app/manifest.ts`) and icon paths `/icons/*.png`. Task 13 (Bubblewrap) reads these.

- [ ] **Step 1: Write the failing test.** `test("the app has an installable identity")` reads `apps/web/app/manifest.ts` and asserts:
  - `name: "Nexus"`, `short_name: "Nexus"`, `start_url: "/inbox"`, `display: "standalone"`;
  - icons `/icons/icon-192.png` (sizes `192x192`), `/icons/icon-512.png` (`512x512`), and `/icons/icon-maskable-512.png` with `purpose: "maskable"`;
  - the three PNG files exist, and their sizes are read from the PNG header bytes 16–23.

  `test("iPhone treats it as an app")` asserts `layout.tsx` contains `appleWebApp` with `capable: true` and `apple-touch-icon.png`.
- [ ] **Step 2:** Run `cd apps/api && node --import tsx --test test/nexus-installs-on-a-phone.test.mjs`. Expected: FAIL (file not found).
- [ ] **Step 3: Implement.**
  - `make_icons.py` draws the existing Nexus mark (the rounded-square + node logo used in `apps/web/app/landing.tsx`) on the Clear Sky brand blue. The maskable variant keeps the mark inside the 80% safe zone. Run it once and commit the PNGs.
  - `manifest.ts` exports `default function manifest(): MetadataRoute.Manifest` with the Global Constraints values, `background_color`/`theme_color` taken from the Clear Sky tokens, and `id: "/inbox"`.
  - Add `appleWebApp: { capable: true, title: "Nexus", statusBarStyle: "default" }` and `icons: { apple: "/icons/apple-touch-icon.png" }` to `metadata`, and export `viewport` with `themeColor`.
- [ ] **Step 4:** Run the test. Expected: PASS. Then `bash scripts/check.sh`. Expected: `typecheck ok`, all tests pass.
- [ ] **Step 5: Commit:** "Nexus has an app identity a phone can install".

### Task 2: Service worker, offline page, registration

**Files:**
- Create: `apps/web/public/sw.js`, `apps/web/public/offline.html`
- Create: `apps/web/app/sw-register.tsx` (client component, renders null)
- Modify: `apps/web/app/layout.tsx` (render `<ServiceWorkerRegister />` in body)
- Modify: `apps/web/next.config.mjs` (headers: `/sw.js` → `Cache-Control: no-cache`, `Service-Worker-Allowed: /`)
- Test: `apps/api/test/nexus-installs-on-a-phone.test.mjs` (extend)

**Interfaces:**
- Produces: `sw.js` handles a `push` event payload of shape `{ title: string, body: string, tag: string, url: string }` (Task 9 sends exactly this). On `notificationclick` it focuses an open Nexus window and navigates it to `url`, or opens one.

- [ ] **Step 1: Write the failing tests.**
  - `test("the service worker never caches private data")`: `sw.js` contains no `cache.put`/`cache.addAll` call whose argument mentions `/api`; the only precache list is `["/offline.html"]`; the fetch handler returns early for any request whose URL path starts with `/api` or whose host is `api.nexusagenticos.com`.
  - `test("a push becomes a notification that opens the chat")`: `sw.js` has `self.addEventListener("push"` calling `showNotification(data.title` with `tag: data.tag` and `data: { url: data.url }`; it also has `"notificationclick"` with `clients.openWindow` and `navigate(`.
  - `test("the worker is registered once, from the root")`: `sw-register.tsx` calls `navigator.serviceWorker.register("/sw.js", { scope: "/" })`, guarded by `"serviceWorker" in navigator`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The fetch handler serves the network first; only for `request.mode === "navigate"` and a network failure does it return the cached `/offline.html`.
  - `offline.html` is self-contained, styled inline: "You're offline. Nexus will reconnect when you're back online."
- [ ] **Step 4:** Run the tests and `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "Nexus works as an installed app and says so when offline".

### Task 3: Install prompts

**Files:**
- Create: `apps/web/app/install-app.tsx` (client: `InstallAppButton`, `IosInstallHint`)
- Modify: `apps/web/app/console-shell.tsx` (show both in the header menu area)
- Test: `apps/web/test/installing-nexus.test.mjs` (render test, existing runner)

**Interfaces:**
- Consumes: Task 2's registration (a `beforeinstallprompt` event only fires once the worker is registered).
- Produces: `IosInstallHint` links to `/app#iphone`, the page Task 14 creates.

- [ ] **Step 1: Write the failing render tests.**
  - `InstallAppButton` renders nothing until a `beforeinstallprompt` event is dispatched, then renders "Install app".
  - `IosInstallHint` renders "Install Nexus on your iPhone" with href `/app#iphone` only when the user agent matches `/iPhone|iPad/` and `navigator.standalone !== true`. It renders nothing after dismissal (localStorage key `nexus.iosHintDismissed`, wrapped in try/catch).
- [ ] **Step 2:** Run `cd apps/web && node test/run.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement both components.
- [ ] **Step 4:** Run the tests and `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "The console offers to install itself".

### Task 4: Phone-first inbox (and the owner deck on one column)

**Files:**
- Modify: `apps/web/app/inbox/page.tsx` (URL state: read `?c=` and `?panel=details` on load; push state on open/back)
- Modify: `apps/web/app/inbox/inbox.css` (`@media (max-width: 760px)` stack layout, 44 px targets, composer `position: sticky; bottom: env(safe-area-inset-bottom)`)
- Modify: `apps/web/app/deck/deck.css` (health strip + team list single column under 760 px)
- Test: `apps/api/test/the-inbox-fits-a-phone.test.mjs`

**Interfaces:**
- Produces: `/inbox?c=<conversationId>` opens that chat if it is in the signed-in person's loaded list, otherwise it shows the list. Task 9's notification URLs rely on this.

- [ ] **Step 1: Write the failing tests.**
  - `test("under 760px the inbox is one screen at a time")`: `inbox.css` has an `@media (max-width: 760px)` block that hides the list while a chat is open (a class such as `.ibx-root.has-chat .ibx-list { display: none }`) and shows the details panel only with `.show-details`.
  - `test("a link to a chat opens it, and only if it is yours to see")`: `page.tsx` reads `searchParams.get("c")` and selects that id **only** if it is found in the loaded conversations, with no fetch by that id.
  - `test("the desktop layout is untouched")`: every pre-existing inbox layout test stays green (run the suite).
- [ ] **Step 2:** Run the tests. Expected: FAIL on the first two.
- [ ] **Step 3: Implement.**
  - The back button (header, phone only) calls `router.back()` when history has the chat entry, else clears `?c`.
  - The composer stays visible above the keyboard by using `visualViewport` height in a CSS variable `--vvh`.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "The inbox fits a phone: list, chat, details, one at a time".

### Task 5: Ship Phase 1

- [ ] **Step 1:** `bash scripts/mirror.sh`, then the deploy command. Expected: `PASS - all three running images were built from <sha>`.
- [ ] **Step 2: Verify on the live site.**
  - `curl -s https://nexusagenticos.com/manifest.webmanifest` returns JSON with `"start_url":"/inbox"`.
  - `curl -sI https://nexusagenticos.com/sw.js` shows `cache-control: no-cache`.
- [ ] **Step 3: Phone-size check.** Load the inbox in a 390×844 viewport (built-in browser `resize_window` preset mobile, signed in) and screenshot list → chat → details.
- [ ] **Step 4:** Run Lighthouse installability (`npx lighthouse https://nexusagenticos.com/inbox --only-categories=pwa --quiet`, or Chrome DevTools if the category is retired): installable = yes. Report the result to the owner.

---

## Phase 2 — Notifications

### Task 6: Push subscriptions storage (migration 095 + db module)

**Files:**
- Create: `packages/db/migrations/095-a-phone-that-can-be-told.sql`
- Create: `packages/db/src/push-subscriptions.ts`; export it from `packages/db/src/index.ts`
- Test: `apps/api/test/a-phone-that-can-be-told.test.mjs`

**Interfaces:**
- Produces (all in `packages/db/src/push-subscriptions.ts`):
  - `type PushMode = "mine" | "all" | "paused"`
  - `interface PushSubscriptionRow { id: string; subject: string; organizationId: string | null; endpoint: string; p256dh: string; auth: string; label: string | null; previews: boolean; mode: PushMode; lastSuccessAt: string | null; failureCount: number }`
  - `upsertPushSubscription(input: { subject: string; organizationId: string | null; endpoint: string; p256dh: string; auth: string; userAgent: string | null; label: string | null }): Promise<PushSubscriptionRow>` (on conflict endpoint → update keys, subject, organization; keeps previews and mode)
  - `listPushSubscriptionsForSubject(subject: string): Promise<PushSubscriptionRow[]>`
  - `listPushSubscriptionsForSubjects(subjects: string[]): Promise<PushSubscriptionRow[]>` (cross-tenant via `withAllTenants("push: who to tell")`)
  - `updatePushPreferences(id: string, subject: string, patch: { previews?: boolean; mode?: PushMode }): Promise<PushSubscriptionRow | null>` (WHERE id AND subject)
  - `deletePushSubscription(id: string, subject: string): Promise<boolean>`
  - `recordPushOutcome(id: string, outcome: "ok" | "gone" | "failed"): Promise<void>` (ok → `last_success_at = now()`, `failure_count = 0`; gone → delete; failed → `failure_count + 1`)

- [ ] **Step 1: Write the failing tests.**
  - The migration creates `push_subscriptions` with `endpoint text not null unique`, `mode text not null default 'mine' check (mode in ('mine','all','paused'))` and `previews boolean not null default false`. It has `alter table push_subscriptions enable row level security` plus a `create policy` matching the repo pattern (`organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all'`), and `grant select, insert, update, delete … to nexus_app`.
  - `upsertPushSubscription` SQL has `on conflict (endpoint) do update` and does not touch `previews`/`mode` in the update.
  - `updatePushPreferences` and `deletePushSubscription` both filter `and subject = $`.
  - `recordPushOutcome` deletes on `gone` and sets `failure_count = failure_count + 1` on `failed`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the migration and the module.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS. The "no migration after the RLS pass creates a table without RLS" test also stays green.
- [ ] **Step 5: Commit:** "A phone can be registered to be told".

### Task 7: Web-push sender and payload builder

**Files:**
- Create: `apps/api/src/lib/web-push.ts`
- Modify: `apps/api/package.json` (add `web-push` and `@types/web-push`); `apps/api/src/config/env.ts` (`vapidPublicKey`, `vapidPrivateKey`, `vapidSubject` from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`)
- Test: `apps/api/test/a-notification-says-only-what-it-may.test.mjs`

**Interfaces:**
- Produces:
  - `pushConfigured(): boolean`
  - `interface PushPayload { title: string; body: string; tag: string; url: string }`
  - `buildMessagePayload(input: { conversationId: string; customer: string; business: string; kind: "message" | "assigned"; text: string | null }, previews: boolean): PushPayload`
  - `buildPlatformPayload(problem: string): PushPayload` (tag `platform-<slug>`, url `/deck`)
  - `sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload): Promise<"ok" | "gone" | "failed">` (404/410 → gone; 10 s timeout)

- [ ] **Step 1: Write the failing tests (run `buildMessagePayload` for real).**
  - With previews false: body is `"sent a message"` and contains no customer text; title is `"Aisha · Zipicka"`; tag is `"conv-c1"`; url is `"/inbox?c=c1"`.
  - Kind `assigned`: body is `"was assigned to you"`.
  - With previews true and text `"<b>Hi</b> " + "x".repeat(300)`: the body has no `<`/`>`, length ≤ 120, and ends with `"…"`.
  - `sendPush` source maps status codes 404 and 410 to `"gone"` and sets `timeout: 10000` (or the equivalent `AbortSignal.timeout(10000)`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with the `web-push` library (`setVapidDetails` once, lazily, only when configured). Strip tags from the preview by removing `<…>` sequences, then collapse whitespace.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "A notification says who and where, and the words only if allowed".

### Task 8: Who to tell (pure rules)

**Files:**
- Create: `apps/api/src/services/push-rules.ts`
- Test: `apps/api/test/who-gets-told.test.mjs`

**Interfaces:**
- Produces:

```ts
export interface PushContext {
  direction: "inbound" | "outbound" | null;   // null for non-message events
  kind: "message" | "assigned" | "other";
  assigneeEmployeeId: string | null;
  newAssigneeEmployeeId: string | null;        // for kind "assigned"
  staff: { employeeId: string; active: boolean; onShift: boolean }[]; // of the serving business
  ownerSubjects: string[];                     // "o:<adminId>" of every owner
}
export function decideRecipients(ctx: PushContext): { subjects: string[]; requiresMode: "mine" | "all" }[]
```

- [ ] **Step 1: Write the failing table tests (run it for real).**
  - Inbound message, assignee `e1` active → `[{ subjects: ["e:e1"], requiresMode: "mine" }]`. A device in mode `all` also qualifies; Task 9 treats "all" as including "mine".
  - Inbound message, assignee `e1` **inactive** → `[]` for e1. With nobody else on shift → the owner subjects.
  - Inbound message, unassigned, staff e2 on shift and e3 off shift → `[{ subjects: ["e:e2"], requiresMode: "all" }]`.
  - Inbound message, unassigned, nobody on shift → `[{ subjects: ownerSubjects, requiresMode: "all" }]`.
  - `assigned` to e4 (active) → `[{ subjects: ["e:e4"], requiresMode: "mine" }]`. The previous assignee is not included.
  - Outbound message, or kind `other` → `[]`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `decideRecipients` (pure, no I/O).
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "Who gets told, decided in one place".

### Task 9: Push dispatcher in the worker (+ owner platform alerts)

**Files:**
- Create: `apps/api/src/services/push-dispatcher.ts`
- Modify: `apps/api/src/worker.ts` (call `startPushDispatcher()` after the workers start)
- Test: `apps/api/test/the-dispatcher-only-listens.test.mjs`

**Interfaces:**
- Consumes:
  - `subscribeToInboxEvents` (`apps/api/src/lib/pubsub.ts`);
  - `decideRecipients` (Task 8);
  - `listPushSubscriptionsForSubjects`, `recordPushOutcome` (Task 6);
  - `buildMessagePayload`, `buildPlatformPayload`, `sendPush`, `pushConfigured` (Task 7);
  - existing `findConversationById`, `listEmployees`, `resolvePresence`, plus `computeJobsHealth` (extracted in this task).
- Produces: `startPushDispatcher(): () => void`. It returns an unsubscribe function and is a no-op that logs once when `!pushConfigured()`.

- [ ] **Step 1: Write the failing tests.**
  - The dispatcher module never imports `sendWhatsAppText`, `insertOutboundMessage` or any reply-path module. It reacts only to `subscribeToInboxEvents`.
  - When it builds `PushContext`, the serving business staff list comes from `listEmployees(servingOrgId)` mapped with `active: employee.isActive` and `onShift` from `resolvePresence(...)`.
  - Device filtering: a subscription in mode `paused` is never sent to; `requiresMode: "all"` only reaches devices in mode `all`; `requiresMode: "mine"` reaches `mine` and `all`.
  - Every send is followed by `recordPushOutcome(sub.id, outcome)`. Sends run with `Promise.allSettled`, so one failure does not block the others.
  - Platform alerts: a 5-minute interval reads `computeJobsHealth()`. It alerts owner devices once per failing job or queue name per 6 h, deduped with a Redis key `push:platform:<slug>` set with `EX 21600 NX`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - First move the `/health/jobs` computation out of `apps/api/src/index.ts` into `apps/api/src/lib/jobs-health.ts`, as `computeJobsHealth(): Promise<{ jobs: { job: string; lastRunFailed: boolean; stalled: boolean }[]; queues: { queue: string; failing: boolean }[] }>`. The route then calls it, and its existing tests stay green.
  - Platform alerts fire for any job with `lastRunFailed || stalled` and any queue with `failing`. This covers "a WhatsApp number that was receiving goes silent", because the `whatsapp-inbound-webhook` queue turns failing.
  - The customer name comes from the event's `contactName` or the conversation's contact display name, falling back to `"A customer"`. The business name is the serving business's name.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "The worker tells people's phones, without touching the reply path".

### Task 10: Push API routes

**Files:**
- Create: `apps/api/src/routes/push.ts`; mount it in `apps/api/src/index.ts` as `app.route("/api/me/push", pushRoute)`, before `/api/me`
- Test: `apps/api/test/a-phone-belongs-to-its-person.test.mjs`

**Interfaces:**
- Consumes: Task 6 functions and `readerOf` (`apps/api/src/lib/actor.ts`).
- Produces (used by Task 11):
  - `GET /api/me/push` → `{ configured: boolean; publicKey: string | null; devices: PushSubscriptionRow[] }`
  - `POST /api/me/push` body `{ endpoint, keys: { p256dh, auth }, label? }` → `{ device }`
  - `PATCH /api/me/push/:id` body `{ previews?, mode? }` → `{ device }` | 404
  - `DELETE /api/me/push/:id` → `{ ok: true }` | 404
  - `POST /api/me/push/:id/test` → `{ outcome }`; 503 with `{ error: "Notifications aren't enabled on this server yet." }` when not configured.

- [ ] **Step 1: Write the failing tests.**
  - Every handler derives the subject with `readerOf(scope)`; no handler reads `subject`, `employeeId` or `adminId` from the body.
  - `organizationId` comes from `scope.organizationId ?? null`.
  - `mode` is validated against `mine|all|paused` (400 otherwise).
  - The 503 message text is exact.
  - The route is mounted before `/api/me` in `index.ts`.
  - The reachability contract test: web calls use `/api/me/push` literals.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "Each person manages only their own phones".

### Task 11: Notifications panel (staff Settings + owner page)

**Files:**
- Create: `apps/web/app/deck/notifications-panel.tsx` (client)
- Modify: `apps/web/app/deck/my-settings/page.tsx` (render the panel)
- Create: `apps/web/app/deck/notifications/page.tsx` (operator page rendering the panel); add a nav entry in `apps/web/lib/nav.tsx` under the Setup group, operator-only. Update the nav-guard tests that map every screen.
- Modify: `apps/web/lib/api.ts`: `getPushDevices()`, `registerPushDevice(sub, label)`, `updatePushDevice(id, patch)`, `removePushDevice(id)`, `testPushDevice(id)`
- Test: `apps/web/test/notifications-panel.test.mjs`

**Interfaces:**
- Consumes: Task 10 routes; Task 2's service worker registration (`navigator.serviceWorker.ready`).

- [ ] **Step 1: Write the failing render tests.**
  - When `window.Notification` or `PushManager` is missing (an iPhone Safari tab), the panel shows "Install Nexus to your Home Screen first, then turn notifications on here." with a link to `/app#iphone`, and no "Turn on" button. (Review Focus 1.)
  - When `configured: false`, it shows "Notifications aren't enabled on this server yet."
  - With one device where `lastSuccessAt` is set and `failureCount` is 0, it shows "Working" and "last delivered".
  - With `failureCount` ≥ 5, it shows "This phone stopped receiving — tap to fix".
  - The previews toggle is labelled "Show message text" and is unchecked by default.
  - The mode options are labelled "My chats", "All chats in my business" and "Paused".
  - The person's other devices are listed by label, each with a "Remove" button that calls `removePushDevice(id)`.
- [ ] **Step 2:** Run `cd apps/web && node test/run.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** "Turn on" calls `Notification.requestPermission()` inside the click handler, then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, then `registerPushDevice`. The label is "iPhone", "Android" or "This computer", from the user agent.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "Turn on alerts, test them, see they work".

### Task 12: Ship Phase 2

- [ ] **Step 1: Migration as owner.** `scp packages/db/migrations/095-a-phone-that-can-be-told.sql root@200.141.5.204:/tmp/095.sql`, then `ssh root@200.141.5.204 "cd /opt/nexus && docker compose exec -T postgres psql -U nexus -d nexus -v ON_ERROR_STOP=1 < /tmp/095.sql"`. Expected: CREATE TABLE / ALTER TABLE / CREATE POLICY / GRANT.
- [ ] **Step 2: VAPID keys.** Generate once on the server (`docker exec <api> npx web-push generate-vapid-keys --json`). Append `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT=mailto:aiapps255@gmail.com` to `/opt/nexus/.env` without printing the private key.
- [ ] **Step 3: Deploy.** Mirror and deploy, then `docker compose up -d --force-recreate api worker` so the env is read. The worker log shows "push dispatcher started" (not "push not configured").
- [ ] **Step 4: Verify.** In Edge on desktop (push works there too), sign in as the owner, then go to `/deck/notifications` → Turn on → Send me a test. The notification arrives, and the device row shows "Working". Report to the owner.

---

## Phase 3 — Android download + website

### Task 13: Android TWA build (owner approves the tool download first)

**Files:**
- Create: `mobile/android/twa-manifest.json` (Bubblewrap config), `mobile/android/README.md` (rebuild steps)
- Modify: `.gitignore` (`mobile/android/*.keystore`, `mobile/android/.keystore-pass`, `mobile/android/build/`)
- Create: `apps/web/public/.well-known/assetlinks.json`
- Create: `apps/web/public/download/nexus-1.0.0.apk` and `apps/web/public/download/nexus.apk` (copy of latest)
- Test: `apps/api/test/the-android-app-is-ours.test.mjs`

**Interfaces:**
- Consumes: Task 1's manifest and icons.
- Produces: the APK files above, and `mobile/android/release.json` = `{ "version": "1.0.0", "sha256": "<file sha256>" }` (read by Task 14).

- [ ] **Step 1:** Ask the owner to approve installing `@bubblewrap/cli` plus JDK 17 and the Android SDK (about 1 GB), and where to back up the keystore. Do not proceed without a yes.
- [ ] **Step 2: Write the failing tests.**
  - `assetlinks.json` contains `"package_name": "com.nexusagenticos.app"` and a `sha256_cert_fingerprints` entry matching `/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/`.
  - `twa-manifest.json` has `packageId` `com.nexusagenticos.app`, `host` `nexusagenticos.com`, `startUrl` `/inbox`, `enableNotifications: true`.
  - `release.json` sha256 equals the actual sha256 of `apps/web/public/download/nexus.apk`, computed in the test with `node:crypto`.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4: Build.**
  - `npx @bubblewrap/cli init --manifest https://nexusagenticos.com/manifest.webmanifest --directory mobile/android`, accepting the JDK/SDK install.
  - Generate the keystore with a random password written to `.keystore-pass`.
  - Run `bubblewrap build`.
  - Copy `app-release-signed.apk` to both download paths.
  - Write the fingerprint from `bubblewrap fingerprint` into `assetlinks.json`, and the sha256 into `release.json`.
  - Copy the keystore and password to the owner's backup location.
- [ ] **Step 5:** Run the tests and `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 6: Commit:** "Nexus for Android, signed and provably ours".

### Task 14: `/app` page and "Nexus in your pocket" on the landing page

**Files:**
- Create: `apps/web/app/app/page.tsx` (server component; reads `mobile/android/release.json` at build time; renders the QR SVG via `qrcode`'s `toString(url, { type: "svg" })`)
- Create: `apps/web/app/app/app-page.css`
- Create: `apps/web/app/get-the-app.tsx` (client: device-aware buttons)
- Modify: `apps/web/app/landing.tsx` (new section, between the existing feature sections and the staff sign-in)
- Modify: `apps/web/middleware.ts` only if `/app` is caught by the auth matcher (it is not today: matcher is `/`, `/deck/:path*`, `/inbox/:path*`)
- Modify: `apps/web/package.json` (add `qrcode`)
- Test: `apps/web/test/get-the-app.test.mjs`

**Interfaces:**
- Consumes: `release.json` (Task 13); `/download/nexus.apk`.

- [ ] **Step 1: Write the failing render tests.**
  - `GetTheApp`:
    - Android UA → a link "Download for Android" to `/download/nexus.apk`;
    - iPhone UA → "Install on iPhone" to `/app#iphone`;
    - desktop UA → the QR code (an `<svg` element) plus both links as text.
  - The `/app` page has an element with `id="iphone"` containing exactly the 3 steps "Open nexusagenticos.com in Safari", "Tap Share, then Add to Home Screen" and "Open Nexus from your Home Screen and turn on notifications in Settings". It also shows `Version 1.0.0` and the 64-hex SHA-256 from `release.json`.
  - The landing section heading is "Nexus in your pocket" and includes the line "Lock-screen alerts show who wrote, never what — unless you choose."
- [ ] **Step 2:** Run `cd apps/web && node test/run.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The phone mockup is a CSS-drawn device frame around a static screenshot of the phone inbox: `apps/web/public/app/inbox-phone.png`, captured in Task 5 Step 3 with customer names blurred.
  - Use the landing page's existing tokens and type. Honour reduced motion.
- [ ] **Step 4:** Run `bash scripts/check.sh`. Expected: PASS.
- [ ] **Step 5: Commit:** "The website hands people the app".

### Task 15: Ship Phase 3 and the real-device check

- [ ] **Step 1:** Mirror and deploy. Then:
  - `curl -sI https://nexusagenticos.com/download/nexus.apk` → `200` and `content-type: application/vnd.android.package-archive`. Add the MIME mapping in `next.config.mjs` headers if missing.
  - `curl -s https://nexusagenticos.com/.well-known/assetlinks.json` → JSON with the fingerprint.
- [ ] **Step 2:** Check `/app` and the landing section at 390 px and at desktop width in the built-in browser. Screenshot them.
- [ ] **Step 3: Real devices, with the owner.**
  - **iPhone:** Safari → `/app` → Add to Home Screen → open → sign in → Settings → Turn on → Send me a test → tap opens Nexus.
  - **Android:** `/app` → Download → allow installs from this site once → open (no URL bar = assetlinks working) → turn on → test.
  - Send a real customer message to an assigned chat → the assignee's phone alerts, with no message text by default.
- [ ] **Step 4:** Update memory (`nexus-mobile-app.md` and the MEMORY.md index) with the keystore location, backup location, VAPID setup and rebuild steps.
