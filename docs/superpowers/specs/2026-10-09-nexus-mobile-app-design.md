# Nexus on the phone — installable app, push alerts, Android download

Date: 2026-10-09 · Status: approved in conversation, awaiting written-spec review

## Intent (what the owner asked for, and what was agreed)

- **Said:** "create an iOS and Android app for this platform, then put it in the website front, creative and reliable."
- **Agreed in conversation:**
  - **Who uses it:** one app for **staff and the owner** (two sign-ins).
  - **Where it's offered:** **only from the Nexus website**, not on the App Store or Google Play.
  - **Approach:** **installable Nexus app (PWA) plus an Android download**.
- **Hard constraint stated to the owner:** an iPhone cannot install a native app from a website without Apple developer or enterprise accounts. iPhone users therefore install through Safari's **Add to Home Screen**. That gives a full-screen app with its own icon and real push alerts (iOS 16.4 or newer).
- **Success looks like:**
  1. A staff member installs Nexus on an iPhone or Android phone from the website in under a minute.
  2. They get a lock-screen alert when a customer writes in one of their chats or a chat is assigned to them, and tapping it opens that chat.
  3. They can reply comfortably one-handed.
  4. The owner gets the same, plus alerts when the platform breaks.

## Out of scope

- App Store or Play Store listings.
- A separate native codebase.
- A customer-facing app.
- Offline replying (the app shows a clear "you're offline" state instead).

## Architecture

The app *is* the existing Next.js web app (`apps/web`), made installable. There is no second codebase. The Android download wraps the same site in a Trusted Web Activity. Push alerts are sent by the API worker, which listens to the inbox event channel that already exists (`subscribeToInboxEvents` in `apps/api/src/lib/pubsub.ts`). No existing send path changes.

```
phone (installed PWA / Android TWA)
  ├─ service worker (apps/web/public/sw.js): receives push, shows notification, opens the chat on tap
  └─ web app pages (phone-first inbox)  ──HTTPS──▶ api.nexusagenticos.com
                                                    ├─ /api/me/push/* (subscribe, unsubscribe, test, status)
                                                    └─ worker: push-dispatcher ◀── Redis inbox events (existing)
                                                                     └─ web-push (VAPID) ──▶ Apple/Google push services
```

## Units

### 1. Installable app (`apps/web`)
- **`app/manifest.ts`:** name "Nexus", short name "Nexus", start URL `/inbox`, `display: standalone`, theme and background colours from the Clear Sky tokens, and maskable icons at 192/512 px.
- **iOS meta:** `apple-touch-icon`, `apple-mobile-web-app-capable` and status-bar style in `app/layout.tsx`.
- **`public/sw.js`, a deliberately small service worker** with three jobs:
  - push and notification-click handling;
  - an offline fallback page;
  - **no caching of API data**, so nobody ever reads stale or private data from a cache.
- **`public/offline.html`:** "You're offline. Nexus will reconnect when you're back online."
- **Install help:** if Chrome offers its install prompt (`beforeinstallprompt`), an **Install app** button appears. On iOS Safari, a one-time hint links to `/app`.

### 2. Phone-first inbox (`apps/web/app/inbox`)
- **Below 760 px the inbox becomes a stack:** chat list → chat → customer details. Each is full screen, with a header back button and the browser/OS back gesture (route state in the URL, e.g. `?c=<id>&panel=details`).
- **Composer:**
  - stays above the keyboard (`visualViewport`-aware, safe-area insets);
  - targets are at least 44 px;
  - quick replies and attachments are one tap;
  - the Call button sits in the chat header.
- **Desktop layout is unchanged.** Existing inbox layout tests keep passing; new tests pin the phone breakpoints.
- **Owner on the phone:** the existing health strip plus a compact "team now" list on `/deck`, re-flowed to one column. No new data.

### 3. Push notifications
- **Data (migration 095):** table `push_subscriptions`:
  - `id`;
  - `subject_kind` ('employee' | 'operator');
  - `subject_id` (employee id or admin id);
  - `organization_id` (nullable for the owner);
  - `endpoint` (unique);
  - `p256dh`, `auth`;
  - `user_agent`, `label` (e.g. "iPhone");
  - `previews boolean default false`;
  - `mode text default 'mine'` ('mine' | 'all' | 'paused');
  - `created_at`, `last_success_at`, `failure_count`.

  It has RLS on `organization_id` like other tenant tables. The owner's rows are read through `withAllTenants` with a named reason. Migrations run as the owner via psql.
- **API (`apps/api/src/routes/push.ts`, session-scoped to the caller):**
  - `GET /api/me/push`: VAPID public key, this caller's devices, and status;
  - `POST /api/me/push`: subscribe or refresh, keyed by endpoint;
  - `PATCH /api/me/push/:id`: previews and mode;
  - `DELETE /api/me/push/:id`;
  - `POST /api/me/push/test`: sends a test to that device.
- **Dispatcher (`apps/api/src/services/push-dispatcher.ts`, run in the worker):** subscribes to inbox events and decides who to notify with a pure function, `decideRecipients(event, conversation)`:
  - **`message`, inbound, chat assigned:** the assignee's devices (mode `mine` or `all`).
  - **`message`, inbound, unassigned:** devices in mode `all` for staff of the serving business who are on shift. If no staff are on shift, the owner's devices.
  - **`assigned`:** the new assignee's devices.
  - **Outbound messages, notes and status changes:** nobody.
- **Platform alerts (owner only):** when job health turns `failing`/`stalled` (the same signal as the health strip), or a WhatsApp number that WAS receiving goes silent while its health check fails. At most one alert per problem per 6 h. Never for a state the owner already knows, such as "no numbers connected yet".
- **Content:**
  - Title: "<Customer> · <Business>".
  - Body: "sent a message" / "was assigned to you". The message text is included **only** if that device has `previews = true`.
  - Tag: `conv-<conversationId>`, so repeat messages replace each other instead of stacking.
  - Payload URL: `/inbox?c=<id>`.
- **Delivery hygiene:**
  - A 404/410 from the push service deletes the subscription.
  - Any other failure increments `failure_count`; at 5 failures the device is marked broken and shown as such in Settings.
  - `last_success_at` is updated on success.
  - Sending is fire-and-forget per device with a timeout, so one dead device never delays others.
- **Keys:** `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` go in `/opt/nexus/.env`, generated once. Without them the dispatcher stays off and Settings says so plainly.
- **Settings UI:** a "Notifications on this phone" panel in `/deck/my-settings` for staff, and at `/deck/notifications` for the owner (owner sessions can't open the staff-only settings page). It has:
  - **Turn on**, which asks permission only on tap (iOS requires a user gesture and an installed app);
  - **Send me a test**;
  - **Show message text** (off by default);
  - **Which chats** (Mine / All in my business / Paused);
  - the status line (working / last delivered / stopped — tap to fix);
  - a list of this person's other devices with Remove.

### 4. Android download
- **Built with Bubblewrap** (Google's TWA generator) from the live manifest. Package id `com.nexusagenticos.app`; launcher name "Nexus".
- **One-time machine setup:** JDK 17 and the Android command-line tools, about 1 GB. **The owner approves the download first.**
- **Signing key:** created once and stored at `nexus-agentic-os/mobile/android/nexus-release.keystore` (git-ignored). A backup goes to a location the owner chooses. Its SHA-256 fingerprint goes into `apps/web/public/.well-known/assetlinks.json`, which makes the app open full screen with no URL bar.
- **The download:** served at `app.nexusagenticos.com/download/nexus-<version>.apk`. `/download/nexus.apk` points to the latest. The `/app` page shows the version and the file's SHA-256 so staff can trust it.
- **Updates:** content and features update live. A new APK is needed only when the name, icon, package or permissions change.

### 5. Website section ("Nexus in your pocket")
- **On the landing page (`apps/web/app/landing.tsx`):** a section with a phone mockup of the real phone inbox. The call to action adapts to the device:
  - **Android:** **Download for Android**.
  - **iPhone:** **Install on iPhone**, which goes to `/app#iphone`.
  - **Desktop:** a QR code for `/app`, generated in the page with no external service.
- **`/app` page:**
  - a 3-step illustrated iPhone guide (Safari → Share → Add to Home Screen → open, then turn on notifications);
  - Android steps (download → allow installs from this site once → open);
  - the APK version and checksum;
  - "what you get".
- **Copy is written for staff:** instant alerts on your own chats, reply on the go, private lock screen by default.

## Error handling

| Situation | Behaviour |
|---|---|
| Notification permission denied | Settings shows how to re-enable it, per platform. |
| iOS opened in the Safari tab, not the installed app | "Turn on" explains that alerts need the home-screen app (iOS rule). |
| Push service rejects (404/410) | The subscription is deleted silently. |
| Repeated failures | The device is flagged broken in Settings, and the owner sees it in the team view. |
| VAPID keys missing | The dispatcher logs once at boot; Settings shows "Notifications aren't enabled on this server yet". |
| Offline | `offline.html` is shown; API data is never served from a cache. |
| Session expired inside the installed app | The normal sign-in screen is shown; "Keep me signed in" is respected. |

## Testing

- **Unit:**
  - `decideRecipients` covers the event matrix: assignee, unassigned on shift, nobody on shift → owner, outbound ignored, paused devices skipped;
  - payload builder: previews off hides the text, tag per conversation;
  - failure bookkeeping: 404/410 deletes, 5 failures flag the device.
- **Contract tests (the repo's text-pin style):**
  - manifest fields and icon sizes;
  - service worker never caches `/api`;
  - push routes are session-scoped (no subject id taken from the request body);
  - migration 095 has RLS and a policy;
  - the inbox phone breakpoints exist and the desktop layout pins are unchanged.
- **Gates:** `scripts/check.sh` (typecheck + full suite) before every commit; Lighthouse installability check on the deployed site.
- **Real devices, with the owner at the end:**
  - iPhone: Add to Home Screen → turn on → test alert → tap opens the chat.
  - Android APK: install → test alert.
  - A real inbound message triggers the assignee's alert.

## Delivery — three shippable phases

1. **Installable app + phone-first inbox:** manifest, icons, service worker, offline page, phone stack layout, install hints. Deployed and checked on a phone-sized viewport.
2. **Notifications:** migration 095 (as owner), VAPID keys, routes, dispatcher, Settings panel. Deployed, test alert verified.
3. **Android download + website section:** Bubblewrap build (after the owner approves the tool download), assetlinks, `/app` page, landing section, QR code. Deployed, then the real-device check with the owner.

Each phase is a separate commit set, deployed with the standard flow (`check.sh` → commit → `mirror.sh` → `deploy.sh`) and verified before the next starts.
