# Staff chat like a WhatsApp group — voice notes, emojis, reactions, replies, photos and files

Date: 2026-11-02
Status: approved in conversation (look, voice notes, extras, data/tests — all "Looks right")
Builds on: `2026-10-24-team-chat-design.md` (the team room and direct chats),
`2026-11-01-cream-foundation-design.md` (Cream theme, motion kit, sounds).

## What the owner asked for

> "make the staff chat like the whats app group chat also has emojis and press
> to hold mic option be relialble on it"

Decisions the owner made:

1. **WhatsApp layout in Nexus's Cream colours** — not WhatsApp's own green.
2. **All four extras:** emoji keyboard, emoji reactions, reply to a message,
   photos and files (voice notes were already in).
3. **Files live in the database**, beside the messages, under the same tenant
   policy and the same nightly verified backup. No new storage service.
4. **Staff chat is built and deployed before part 2a** of the redesign.

Success: on a phone, a staff member presses and holds the mic, talks, lets go,
and every colleague hears the note seconds later, with the real waveform; they
can react, reply, send a photo or a PDF, and nothing is ever lost, doubled or
visible to another business. The admin can listen to and see everything, and
writes only in team rooms, as today.

## Scope

In: the Team chat page (`/deck/team-chat`) and the team dock beside the inbox
(`app/inbox/team-dock.tsx`). Both already draw messages with
`ThreadMessages` (`app/team-chat-thread.tsx`); after this change they also share
one message box.

Out: video messages, voice/video calls, editing a sent message, forwarding,
"message info" (who read what, per person), polls, starring, search inside the
chat, group chats other than the team room, chat with customers (the inbox is
untouched), transcribing voice notes.

## 1. Look and feel

- **Header:** dark ink bar — round chat picture (the business initials for the
  room, the colleague's photo or initials for a direct chat), the name, and the
  members line ("Sara, Rohan, Theo, you"). Tapping it lists the members.
- **Wallpaper:** a faint repeating doodle (chat bubbles, phones, stars, coffee
  cups, paper planes) drawn as one inline SVG in `--st-mustard` and
  `--st-forest` at low opacity on `--marble`; a Warm Night version in dark mode.
- **Bubbles:** tails, as in WhatsApp. Mine on the right in `--sky-soft`; others
  on the left in `--paper`. A run of messages from one person within 5 minutes
  is grouped: name and tail only on the first.
- **Names in colour:** each colleague's name takes one colour from a fixed
  palette of 8, chosen by a stable hash of the employee id (the admin always
  takes ink). Every colour is at least 4.5:1 on the light bubble and on the
  Warm Night bubble; a test checks this. The "Admin" label stays.
- **Time and ticks inside the bubble:** 🕓 sending, ✓ sent, ✓✓ in forest once
  seen — by the colleague in a direct chat, by every current member in the room.
  "Not sent · Retry" stays as today.
- **Day pills** float centred ("Today", "Yesterday", "Monday 27 Oct"). On
  opening a thread with unread messages, a strip "N unread messages" sits above
  the first of them.
- **Message box:** 😊 emoji · 📎 attach · the text box · one round button that
  is 🎤 while the box is empty and ➤ once there is text (the same morph as
  WhatsApp). @mentions keep working. The box stays above the phone keyboard.
- **Motion** (part 1's kit, off under reduced motion): new bubbles rise in;
  the reaction bar pops from the bubble; the recording bar slides in.
- **Sound** (part 1's `play()`, honours the mute switch): `pop` on send,
  `tick` when recording starts, `whoosh` on cancel, `ping` on incoming (today's).
- **Phones:** full screen with a back arrow, as now.

## 2. Voice notes

### Recording

The recorder is a pure state machine (`idle → holding → recording ⇄ paused →
review → sending`, plus `locked` and `cancelled`) in its own module with no
DOM, so every rule below is tested without a browser.

- **Touch:** press and hold 🎤 → red dot, running timer, "‹ Slide to cancel".
  Release → send. Slide left past 96 px → cancel (the note drops into a small
  bin; nothing is sent). Slide up past 72 px onto 🔒 → locked: recording
  continues hands-free with 🗑 Delete, ⏸ Pause / ▶ Resume, ➤ Send.
- **Mouse:** a press on 🎤 released within 300 ms (a click) starts straight
  into the locked bar. A longer press behaves exactly like touch: release
  sends, slide left cancels, slide up locks.
- **Too short:** under 1 second is never sent; a hint says "Hold to record,
  release to send".
- **5-minute limit:** at 5:00 recording stops and the locked review bar shows,
  so nothing is cut and lost.
- **Interrupted** (tab hidden, screen locked, a call takes the mic, the track
  ends): the recording pauses into the review bar.
- **Microphone blocked:** a plain message names how to allow it in this
  browser; nothing else changes.
- **Format:** the first of `audio/mp4` (AAC), `audio/webm;codecs=opus`,
  `audio/ogg;codecs=opus` that `MediaRecorder.isTypeSupported` accepts. Mono.
- **Waveform:** an `AnalyserNode` samples the level while recording; the
  peaks are folded into 64 bars (0–100) and sent with the note, so playback
  shows the real waveform at once without decoding the file.

### Playing

- ▶ / ⏸, the waveform (played part in forest), the time, and a speed chip
  1× → 1.5× → 2×. Tapping or dragging the waveform seeks.
- One note plays at a time; consecutive notes in the thread play on in order.
- The file is fetched once (with credentials) into a blob and played from an
  object URL, so playback needs no Range support from the server and replays
  are instant.
- A dot marks notes not yet played on this device (`localStorage`, wrapped in
  try/catch; without storage every note simply shows as played).
- If `canPlayType` says the device cannot play the note's type, the bubble
  shows ⬇ Download instead of a broken player.

## 3. Emojis, reactions, replies, photos and files

### Emoji keyboard

- 😊 opens a panel above the box: search, "Recently used" (this device), and
  category tabs. A long press on an emoji with skin tones offers them.
- The list is Emoji 15.0 and earlier (renders on iOS 16.4+ / Android 14+ /
  Windows 11), generated once by `scripts/build-emoji-data.mjs` from Unicode's
  `emoji-test.txt` and CLDR English annotations, committed as
  `apps/web/public/emoji/en.json`, and fetched only when the panel first opens.
- Emojis are drawn by the device's own emoji font. No images.

### Reactions

- **Touch:** press and hold a bubble (450 ms) → it lifts, the thread dims,
  and a bar of 👍 ❤️ 😂 😮 😢 🙏 ＋ appears with a menu: Reply, Copy, Remove
  (own messages only). ＋ opens the emoji keyboard.
- **Mouse:** hover shows 🙂 and ⌄ at the bubble's edge.
- One reaction per person per message: another emoji replaces it, the same
  one again removes it.
- Shown under the bubble as chips ("👍 2 ❤️ 1"); tapping a chip lists who.
- Live for everyone, with a small pop.

### Reply to a message

- Swipe a bubble right past 64 px (touch), or choose Reply.
- A quote strip above the box: the author in their colour and a snippet —
  "🎤 Voice note 0:12", "📷 Photo", "📄 price-list.pdf", or the first 120
  characters of text. ✕ clears it.
- In the thread, the reply shows the quote inside the bubble; tapping it
  scrolls to the original and flashes it. If the original is older than what
  is loaded, earlier pages load until it is found. A removed original reads
  "Message removed".
- A reply must point at a message in the same thread (checked server side).

### Photos and files

- 📎 → 📷 Camera (phones), 🖼 Photos, 📄 Document. On a computer, files can
  also be dropped onto the thread or pasted.
- A preview screen with a caption box comes before sending. Several photos go
  as several messages; the caption goes with the first.
- **Photos** are shrunk on the device: longest side 1600 px, JPEG quality 0.82,
  plus a 320 px preview. GIFs are sent as they are (shrinking would stop the
  animation) if within the limit. A photo the browser cannot decode (an old
  HEIC, say) is offered as a document instead.
- In the thread, the preview shows at once; tapping opens a full-screen viewer
  with pinch / wheel zoom and ⬇ Download.
- **Files** show an icon by type, the name, the size and the type. Tapping
  downloads.
- Each upload shows a progress ring and can be cancelled; a failed one shows
  "Not sent · Retry".
- **Limits:** photo 5 MB (after shrinking), preview 200 KB, file 16 MB,
  voice note 5 minutes and 6 MB.

### The admin

As today: everything above in team rooms; direct chats are read-only for the
admin — no sending, reactions or replies there, but notes play and files open.

## 4. Data — migration `104-team-chat-media.sql`

Idempotent, like every migration here, and applied by hand on the VPS before
the new API starts (this project has no migration runner in production).

`team_files`
- `id uuid pk default gen_random_uuid()`, `organization_id uuid not null →
  organizations`, `thread_id uuid not null → team_threads on delete cascade`
- `uploader text not null` (employee id, or `admin:<adminId>` as in `team_reads`)
- `kind text check in ('voice','photo','file')`
- `mime text not null` — the type the server detected, never the browser's
  claim; `name text not null` (1–200 chars, path parts stripped); `size int`
- `bytes bytea` — set to null when its message is removed
- `preview bytea` (photos), `width int`, `height int` (photos)
- `duration_ms int` (voice, 1000–305000), `waveform smallint[]` (voice, ≤128
  values, each 0–100)
- `created_at timestamptz default now()`, `deleted_at timestamptz`
- the standard tenant policy, granted to `nexus_app`

`team_messages` gains
- `file_id uuid → team_files on delete set null`
- `reply_to uuid → team_messages on delete set null`
- the body check becomes: 1–4000 characters, or 0–4000 when `file_id` is set

`team_reactions`
- `message_id uuid → team_messages on delete cascade`, `organization_id`,
  `reactor text` (employee id or `admin:<id>`), `reactor_name text`,
  `emoji text` (1–16 characters), `created_at`
- primary key `(message_id, reactor)`; the standard tenant policy

## 5. API — inside `/api/team-chat`, same `teamAccess`, same 404 for anything not yours

- **Send with a file.** `POST /threads/:id/messages` keeps its JSON form and
  also accepts `multipart/form-data`: `clientId`, `body` (caption), `replyTo`,
  `mentions`, `kind`, `file`, and for photos `preview`, `width`, `height`, for
  voice `durationMs`, `waveform`. The request must carry `Content-Length` and
  be under 17 MB, or it is refused before the body is read (411 / 413). The
  same `clientId` returns the first saved message and stores no second file:
  the file and message are written in one transaction, after the clientId
  check.
- **Type checks by content.** Photos must start with JPEG, PNG, WebP or GIF
  bytes; voice with MP4/M4A, WebM or Ogg bytes; anything else is refused for
  that kind. Files may be any type but are only ever served for download.
- **Fetch.** `GET /files/:id` and `GET /files/:id/preview` check `teamAccess`
  on the file's thread. Photos (the four types above) and voice notes are
  served with their type; everything else as `application/octet-stream` with
  `Content-Disposition: attachment`. Always `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox`, `Cache-Control: private, max-age=31536000,
  immutable`. A removed file is 404.
- **Reactions.** `PUT /messages/:id/reaction` `{ emoji }` sets or replaces the
  viewer's reaction; `DELETE` removes it. Not allowed where the viewer cannot
  post (the admin in a direct chat). Publishes `team_reaction`.
- **Shapes.** `TeamChatMessage` gains `file` (`id, kind, name, size, mime,
  durationMs, waveform, width, height`, no bytes), `replyTo` (`id,
  authorName, snippet, removed`) and `reactions` (`[{ emoji, by: [{ key, name
  }] }]`; each screen works out "mine" from its own key, so one live event
  serves every viewer). Room threads also return `seenByAllAt`, the earliest
  `last_read_at` among the room's current members; `team_read` events for a
  room carry it.
- **Removal.** Removing a message nulls its file's `bytes` and `preview` and
  sets `deleted_at` in the same statement batch.

## 6. Reliability

- Retries reuse the clientId; a pending file stays in memory until the server
  confirms it, and a page reload drops nothing that was confirmed.
- Upload progress comes from `XMLHttpRequest` upload events (fetch cannot
  report it), and cancelling aborts the request.
- Live events as today, plus `team_reaction`; on reconnect the thread re-reads.
- The recorder releases the microphone on every exit path (send, cancel,
  error, unmount), so the phone's mic indicator never stays on.

## 7. Files

Web, new: `lib/team-chat/recorder.ts` (state machine), `lib/team-chat/waveform.ts`,
`lib/team-chat/shrink-image.ts` (sizes and quality maths; canvas only at the edge),
`lib/team-chat/emoji-search.ts`, `lib/team-chat/name-colour.ts`,
`lib/team-chat/gestures.ts` (swipe and hold thresholds),
`app/team-chat/composer.tsx`, `voice-recorder.tsx`, `voice-note.tsx`,
`emoji-panel.tsx`, `attach.tsx`, `photo-viewer.tsx`, `reactions.tsx`,
`message-menu.tsx`, and `app/team-chat/team-chat.css`; `scripts/build-emoji-data.mjs`,
`public/emoji/en.json`. Changed: `app/team-chat-thread.tsx`,
`app/deck/team-chat/page.tsx`, `app/inbox/team-dock.tsx`,
`lib/use-team-thread.ts`, `lib/use-team-socket.ts`, `lib/api.ts`.

API and DB: `packages/db/migrations/104-team-chat-media.sql`, the team chat
data module in `packages/db/src`, `apps/api/src/routes/team-chat.ts`,
`apps/api/src/lib/team-events.ts`.

## 8. Testing (written first, red then green)

API (`apps/api/test`):
- another business's thread or file is 404; the admin cannot post, react or
  reply in a direct chat but can fetch its files
- a retried multipart send with the same clientId stores one file and one message
- a PNG labelled as a voice note, or HTML labelled as a photo, is refused; a
  file upload of HTML or SVG is served as an attachment with nosniff and sandbox
- missing Content-Length → 411; over the cap → 413; over-long voice → 400
- removing a message makes its file 404 and nulls its bytes
- reactions: set, replace, remove, one per person; `team_reaction` published
- a reply pointing at another thread's message is refused
- `seenByAllAt` is the earliest read among current room members
- the migration is idempotent and gives all three tables the tenant policy

Web (`apps/web/test`):
- recorder: hold → release sends; slide-left cancels; slide-up locks; under
  1 s never sends; 5:00 stops into review; hidden tab pauses into review;
  every exit releases the microphone
- waveform folding to 64 bars in 0–100; image shrink sizes; emoji search
  ("heart" finds ❤️, "thumbs" finds 👍); name colours ≥4.5:1 on both bubbles
  in both themes; swipe and hold thresholds
- the page and the inbox dock both use the one shared composer

Browser preview (Chromium with the mock API): the thread, emoji panel,
reactions, replies, photo preview and viewer, and a recording driven by a fake
audio stream, each with a screenshot. Real press-and-hold on an iPhone and an
Android phone is checked by the owner after deploy.

## 9. Deploy

1. Push the branch's merge to `main`.
2. On the VPS: `git pull`, then apply `104-team-chat-media.sql` with psql as
   the owner role, then `scripts/deploy.sh`, then `scripts/schema-drift-check.sh`.
3. Wait for "PASS - all three running images were built from <sha>".
