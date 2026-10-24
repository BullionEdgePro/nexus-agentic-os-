# Team chat — design

24 Oct 2026. Approved by the owner in chat ("Design approved. Write the spec,
then the plan, and build it, then deploy to Hostinger.").

## What the owner asked for

> "build an chat box for each of the business staff who assign in each
> business can talk to their collegue for the designated business. only. be
> reliable and creative for it"

Decisions the owner made:

- **Kinds of chat:** one team room per business, plus private 1-to-1 direct
  chats between two colleagues of the same business.
- **Admin:** sees every room and every direct chat in every business, and can
  post in team rooms. Direct chats are read-only for the admin.

Success: a staff member at Zipicka can talk to every Zipicka colleague — in
the room or one to one — and to nobody at any other business; messages arrive
live, are never lost or doubled, and the admin can read all of it.

## Out of scope (first version)

Pictures, files, voice notes, editing a message, group chats other than the
team room, staff-to-admin direct chats.

## Data (migration 101-team-chat.sql)

All three tables carry `organization_id` and the standard tenant policy
(`app.current_org` or `app.tenant_scope = 'all'`), granted to `nexus_app`.

`team_threads`
- `id uuid pk`, `organization_id uuid not null → organizations`
- `kind text check in ('room','direct')`
- `member_a uuid`, `member_b uuid → employees on delete cascade` — set for
  `direct` only, stored with `member_a < member_b`; check that a room has
  neither and a direct thread has both and they differ
- unique: one room per organization; one direct thread per (organization,
  member_a, member_b)

`team_messages`
- `id uuid pk`, `thread_id → team_threads on delete cascade`, `organization_id`
- `author_employee_id uuid → employees on delete set null` (null for admin)
- `author_name text not null` (kept, so a removed colleague's words still say
  who wrote them), `author_is_admin boolean not null default false`
- `body text not null`, 1–4000 characters
- `client_id text not null` — chosen by the sender's screen;
  `unique (thread_id, client_id)` makes a retried send land once
- `mentions uuid[] not null default '{}'` — employee ids, validated server side
- `shared_conversation_id uuid → conversations on delete set null`
- `created_at`, `deleted_at` (soft delete: "Message removed")
- index `(thread_id, created_at desc)`

`team_reads`
- `(thread_id, reader)` primary key; `reader text` is the employee id, or
  `admin:<adminId>` for an admin; `last_read_at timestamptz`

## Who may do what (one function, `teamAccess`)

A viewer is a staff member (`employeeId`, `organizationId`) or an admin.

| | Team room of own business | Direct chat they are in | Any other thread |
|---|---|---|---|
| Staff (active) | read, post | read, post | nothing (404) |
| Admin | read, post (as "Admin") | read only | read only |

- A staff member is checked against `employees.is_active` on every request:
  removing someone from the team cuts them off at once.
- A direct chat can only be opened with an **active colleague of the same
  business**, never with oneself.
- Refusals answer 404, like every other private thing in Nexus.

## API — `/api/team-chat` (scoped inside the handlers, like /api/tasks)

Every handler runs its database work inside `withTenant(organizationId)`.
The admin names the business with `?business=<slug>`.

- `GET /threads` → the room (created on first use) and every direct thread the
  viewer may read, each with the other person, last message, unread count and
  mentioned-unread count; plus `colleagues` (active staff of the business, with
  on-shift from `resolvePresence`) and `canPostInRoom`.
- `POST /direct { employeeId }` → get or create the direct thread (staff only).
- `GET /threads/:id/messages?before=<iso>&limit=50` → newest page, oldest first,
  with "seen by" for the viewer's last message in a direct chat.
- `POST /threads/:id/messages { clientId, body, mentions?, shareConversationId? }`
  → the saved message (201, or 200 with the same message on a repeat clientId).
- `POST /threads/:id/read` → marks read up to now.
- `DELETE /messages/:id` → the author's own message only.
- `GET /unread` → `{ unread, mentioned }` for the sidebar badge.

### Handing over a customer

`shareConversationId` is accepted only in a **direct** chat, only from a staff
member who can see that conversation (`conversationVisibleTo`). Posting it adds
the other member to the conversation's `collaborator_ids` (unless they already
see it). The card shows the customer's name and channel and opens the chat in
the inbox. The composer says "Gives <name> access to this chat" before sending.

## Live delivery

- Saved first, then published on Redis channel `nexus:team-events`:
  `team_message`, `team_message_removed`, `team_read`, each carrying
  `organizationId`, `threadId`, `kind`, and the two members for a direct thread.
- The WebSocket server accepts a second path, `/ws/team`, on the same upgrade
  handler (today any path but `/ws` is destroyed, so the handler is shared).
  A staff socket gets events for its own business's room and its own direct
  chats; an admin socket gets every event (or one business with `?org=`).
- The screen reconnects with back-off; after reconnecting it re-reads the open
  thread and the thread list, so nothing missed while offline is lost. If the
  socket is down it re-reads every 15 seconds.

## The screen — `/deck/team-chat`, "Team chat" in the Home group

- Left: the team room first, then colleagues (on-shift dot, unread and
  mention badges). Right: the open thread and the composer. One pane at a time
  on a phone.
- Staff see one line at the top: "Your admin can read team chats."
- Composer: Enter sends, Shift+Enter is a new line; typing `@` offers
  colleagues; a message shows "Sending…", then its time, or "Not sent · Retry".
- Own messages can be removed ("Message removed" for everyone).
- In a direct chat, "Seen" under your last message once the colleague read it.
- Admin: a business switcher; posts in the room labelled "Admin"; direct chats
  show "Read only — between <a> and <b>".
- Inbox: an "Ask a colleague" button in a customer chat opens a picker of
  colleagues and posts the hand-over card into that direct chat.
- Sidebar badge: unread count (mentions shown in the accent colour), refreshed
  by the socket and every 60 seconds.
- A small alert when someone @mentions you, wherever you are in Nexus.

## Also in this change

The Customers page hides "Customers (CSV)" and "Every message (CSV)" from staff:
those exports are the admin's and answered staff with "Not found".

## Testing

- Source-assertion tests (the repo's pattern) for: the migration and its
  policies; `teamAccess` decisions in every cell of the table above; idempotent
  send; mentions validated; hand-over only from someone who can see the chat;
  the hub's delivery rule; the screen's retry and read-only states; the export
  buttons hidden for staff.
- Unit tests for pure functions (`teamAccess`, mention parsing, direct-pair
  ordering).
- Full `./scripts/check.sh`, deploy, and an on-screen check as Ralph (staff)
  and as the admin.
