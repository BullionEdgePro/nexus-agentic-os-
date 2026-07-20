# Nexus Agentic OS

Multi-tenant WhatsApp Business agentic platform for 5 tenants: Zipicka,
Juris Prime, Juris Prime Legal, SFS International, Atif Ali Production.

```
apps/
  api/        Meta webhook receiver, BullMQ workers, REST + WebSocket API
  web/        Unified Inbox (Next.js)
packages/
  db/         Postgres schema, migrate/seed scripts, query layer
  agents/     Switchboard router + per-tenant Domain Agents (tool-calling)
  governance/ PII scan + LLM-judge hallucination check for outgoing AI replies
  shared/     Types shared across every workspace
```

## 1. Local infrastructure

Requires Docker (Postgres 16 + Redis 7):

```bash
docker compose up -d
```

This also auto-applies `packages/db/schema.sql` and `packages/db/seed.sql` on
first boot (via `docker-entrypoint-initdb.d`). If the containers already
existed before you pulled schema/seed changes, that auto-init won't rerun —
apply them manually instead:

```bash
npm run db:migrate   # re-applies schema.sql (safe to rerun, uses IF NOT EXISTS / no-op on conflict)
npm run db:seed      # re-applies seed.sql
```

## 2. Environment

```bash
cp .env.example .env
```

Fill in, at minimum, for local dev against `docker compose`:
- `DATABASE_URL` / `REDIS_URL` — already correct for the compose defaults.
- `ANTHROPIC_API_KEY` — required for any Domain Agent to actually respond.
- `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_ACCESS_TOKEN` — see
  step 4 below for where these come from.

## 3. Install and run

```bash
npm install
npm run dev:api      # Hono webhook receiver + REST/WS API, :8080
npm run dev:worker   # BullMQ workers (inbound webhook processing, broadcast sends)
npm run dev:web      # Unified Inbox, :3000
```

`npm run typecheck` / `npm run build` run across every workspace.

The seed data (`packages/db/seed.sql`) inserts the 5 organizations with
**placeholder** `whatsapp_phone_number_id` values (`000000000000001`..`5`)
and one active agent config each. Inbound webhooks are routed purely by
`phone_number_id` — a tenant stays unreachable until its placeholder is
replaced with the real ID from that business's WhatsApp Manager:

```sql
update organizations set whatsapp_phone_number_id = '<real id>', whatsapp_business_account_id = '<real id>' where slug = 'zipicka';
```

## 4. Wiring up a real WhatsApp number (per tenant)

1. In [Meta Business Suite](https://business.facebook.com) → WhatsApp
   Manager, note the tenant's **Phone number ID** and **WhatsApp Business
   Account ID** — update the `organizations` row as above.
2. In the Meta App Dashboard → WhatsApp → Configuration:
   - **Callback URL**: `https://<your-public-url>/webhooks/whatsapp`
   - **Verify token**: must exactly match `META_WEBHOOK_VERIFY_TOKEN` in `.env`
   - Subscribe to the `messages` webhook field.
3. Get a permanent **access token** (System User token with
   `whatsapp_business_messaging` permission) → `META_ACCESS_TOKEN`.
4. Get the **App Secret** (App Dashboard → Settings → Basic) →
   `META_APP_SECRET`. This signs every webhook delivery
   (`X-Hub-Signature-256`) — the receiver rejects anything that doesn't
   verify against it.

For local development, Meta needs a public HTTPS URL to reach your machine —
tunnel port 8080 with something like `ngrok http 8080` and use the ngrok URL
as the callback URL above. Re-run the verification step in the dashboard
after the tunnel URL changes.

## 5. Verifying it end-to-end

1. `curl http://localhost:8080/health` → `{"status":"ok"}`.
2. Send the tenant's WhatsApp number a real message. It should show up in
   the Unified Inbox (`npm run dev:web`) within a couple seconds, and the
   configured Domain Agent should reply — check `npm run dev:worker`'s
   output for the Switchboard routing and governance evaluation logs.
3. Toggle "Human handoff" on a conversation in the inbox, or reply as a
   human agent — the AI should go quiet on that contact for 24h
   (`contacts.ai_paused_until`).
4. To test the governance escalation path deliberately, have the agent
   attempt to state something not in its context — the processor logs
   `AI reply blocked by governance evaluation` and the conversation flips to
   human handoff instead of sending the risky reply.

## 6. Broadcasts

Requires an already Meta-approved message template row in
`message_templates` (insert one per approved template — this table isn't
auto-populated, since template approval happens in Meta's dashboard first).

```bash
curl -X POST http://localhost:8080/api/broadcasts \
  -H 'Content-Type: application/json' \
  -d '{"organizationSlug":"zipicka","templateId":"<uuid>","audienceFilter":{}}'

curl -X POST http://localhost:8080/api/broadcasts/<broadcast-id>/send \
  -H 'Content-Type: application/json' \
  -d '{"organizationId":"<org-uuid>","templateId":"<uuid>","audienceFilter":{}}'
```

`audienceFilter` matches `contacts.attributes` via jsonb containment —
`{}` targets every contact in the organization; `{"vip": true}` targets only
contacts with that attribute set.

## Known limitations

- No RAG/knowledge-base retrieval is wired up yet — `agent_configs.rag_collection`
  is a pointer, not an active lookup. Domain Agents currently answer from the
  system prompt + conversation history only.
- The governance hallucination judge calls Claude Haiku on every outgoing AI
  message — factor that into per-message latency and cost.
- `ioredis` logs a warning on every failed reconnect attempt while Redis is
  down; this is intentionally non-fatal (see `lib/pubsub.ts` /
  `queue/queue.ts`) but is noisy in that state — expected during local dev
  before `docker compose up` finishes healthchecking.
