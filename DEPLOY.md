# Deploying to a Hostinger VPS

This stack needs Docker, long-running background processes (BullMQ
workers, a persistent WebSocket server) and full control over Postgres and
Redis — that only works on Hostinger's **VPS** plans (KVM, root SSH access).
Hostinger's shared/Cloud/Business web hosting tiers cannot run this
codebase at all (no Docker, no custom background processes, no database
control) — if that's what you have, stop here and get a VPS plan instead,
or this won't work regardless of what else is fixed.

Recommended VPS spec for all 5 tenants: 2 vCPU / 4GB RAM (KVM 2 or above).
Ubuntu 22.04 or 24.04.

## 1. DNS

Point two subdomains at your VPS's IP address (A records), before starting
Caddy — it needs to answer Let's Encrypt's HTTP challenge on that hostname
to issue a certificate:

- `api.yourdomain.com` → webhook receiver + REST/WS API
- `app.yourdomain.com` → Unified Inbox

(Any hostnames work — these two are what `.env`'s `API_DOMAIN`/`WEB_DOMAIN`
should be set to.)

## 2. Provision the VPS

SSH in as root (Hostinger emails you the IP + initial password, or you set
an SSH key during VPS creation), then:

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
# Docker Compose ships as a plugin with the above; verify:
docker compose version
```

Open ports 80 and 443 if Hostinger's firewall/panel has one enabled (VPS
panel → Firewall). Port 22 (SSH) stays open; nothing else needs to be
public — Postgres/Redis/the API/the web app are only reachable inside the
Docker network, proxied through Caddy.

## 3. Get the code onto the server

```bash
git clone <your-repo-url> /opt/nexus
cd /opt/nexus/nexus-agentic-os
```

(Or `scp`/`rsync` the `nexus-agentic-os/` directory if you don't want the
whole monorepo on the server.)

## 4. Configure

```bash
cp .env.example .env
nano .env
```

Fill in for production:
- `POSTGRES_PASSWORD` — a real generated password (used by the `postgres`
  container and assembled into `DATABASE_URL` automatically by
  `docker-compose.prod.yml` — don't hand-edit `DATABASE_URL` itself for this
  stack, it's overridden either way).
- `API_DOMAIN`, `WEB_DOMAIN` — the two subdomains from step 1.
- `ANTHROPIC_API_KEY` — required for Domain Agents to respond at all.
- `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_ACCESS_TOKEN` — see
  the main [README](README.md#4-wiring-up-a-real-whatsapp-number-per-tenant)
  for where these come from. Set the callback URL in Meta's dashboard to
  `https://<API_DOMAIN>/webhooks/whatsapp` once this is running.

## 5. First deploy

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f caddy
```

Watch the Caddy logs for the certificate issuance — first boot takes ~10-30s
while Caddy talks to Let's Encrypt. Once it's quiet:

```bash
curl -s https://api.yourdomain.com/health   # {"status":"ok"}
```

Open `https://app.yourdomain.com` in a browser — you should see the Unified
Inbox shell with the 5 businesses listed (empty conversation lists, since
the seed data's `whatsapp_phone_number_id`s are placeholders — see the main
README's step 3 for swapping in real ones).

## 6. Updating after a code change

```bash
cd /opt/nexus/nexus-agentic-os
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Postgres data persists in the `nexus-postgres-data` named volume across
rebuilds — `docker compose down` alone won't touch it; only
`docker compose down -v` deletes volumes, so avoid that unless you actually
want to wipe the database.

## 7. Applying a schema change later

`schema.sql`/`seed.sql` only auto-run via `docker-entrypoint-initdb.d` on a
**fresh, empty** Postgres data volume — once the volume exists, edits to
those files need to be applied manually:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U nexus -d nexus < packages/db/schema.sql
```

## Troubleshooting

- **Caddy can't get a certificate**: DNS hasn't propagated yet, or ports
  80/443 aren't actually reachable (check Hostinger's panel firewall, not
  just `ufw` inside the VM). `docker compose -f docker-compose.prod.yml logs caddy`
  shows the actual ACME error.
- **`api`/`worker` keep restarting**: `docker compose -f docker-compose.prod.yml logs api`
  — almost always a missing/wrong env var (this codebase fails loudly with
  `Missing required env var: X` rather than silently misbehaving).
- **Webhook 401s from Meta**: `META_APP_SECRET` in `.env` doesn't match the
  App Secret in Meta's dashboard, or the callback URL isn't exactly
  `https://<API_DOMAIN>/webhooks/whatsapp`.
