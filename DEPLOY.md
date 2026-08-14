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

## 5a. Close the bootstrap door — do this on the first day

Until a named admin account has **signed in**, any syntactically valid email
plus `NEXUS_OPERATOR_PASSWORD` is a full cross-tenant login: every business's
customer conversations, contacts, leads and broadcasts. If `.env` does not set
that variable it defaults to **`demo1234`**.

That is intended only as the way in before any account exists. It closes itself
the moment a real one is used:

```bash
docker compose -f docker-compose.prod.yml exec -T worker \
  npx tsx apps/api/src/scripts/create-admin.ts you@example.com "Your Name"
```

The password is generated on the server and printed **once** — it is never
accepted as an argument, because a password on a command line lands in shell
history. Sign in with it at `https://<WEB_DOMAIN>/admin`.

**The sign-in is what closes the door, not the account.** Retirement is keyed on
`last_login_at`, deliberately: an account created with a password nobody kept
would otherwise lock you out of your own console. Run the script with no
arguments at any time to see which accounts exist and which have never signed
in.

Every use of the shared password logs a warning naming the email that used it —
`docker compose -f docker-compose.prod.yml logs web | grep "SHARED OPERATOR"`
tells you whether the door is still being walked through.

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

## Migration order — which comes first depends on the change

The habit "deploy the code, then run the migration" is right for *additive*
migrations, where new SQL runs harmlessly against the old code. It is wrong,
and produces an outage, whenever the new code **reads something the migration
creates**.

| The change | Run first | Why |
|---|---|---|
| New column the code **reads** or writes | **migration** | Code-first guarantees a window where every query naming that column throws. If the query is on the inbound path, WhatsApp messages are dropped for the length of that window |
| New table the code reads | **migration** | Same |
| Backfill, index, constraint, new table nothing reads yet | **code** | The old code neither knows nor cares |
| Dropping a column | **code** | Ship the version that stopped reading it, then drop |

This bit us on migration 022. `whatsapp_display_number` was added to
`listOrganizations` and `findOrganizationByPhoneNumberId`, both deployed before
the column existed — and the second is the first call the inbound webhook makes,
so every incoming message would have failed until the migration caught up.

The tell is simple: **if the diff adds a column name to a `select`, the
migration goes first.** When unsure, run the migration first — it is idempotent
by convention here, and running it early costs nothing.

## How to actually run one — as the OWNER, never as the app

This was not written down anywhere until 2026-08-14, so every deploy guessed,
and the guess that looks most natural is wrong:

```
docker compose -f docker-compose.prod.yml exec -T api npm run db:migrate   # WRONG
```

The api container connects as **`nexus_app`**, the least-privilege role created
by migration 006: usage on the schema, DML on tables, and no CREATE. That is
deliberate and load-bearing — **RLS policies do not apply to a table's owner**,
so if the application connected as the owner, every policy in migration 018
would silently stop enforcing. `rls-verify` fails the build if the app role ever
gains ownership. So the app role cannot run DDL, and should never be able to.

Migrations therefore run as the owner, `nexus`. Either:

```bash
# Preferred: point the runner at owner credentials.
docker compose -f docker-compose.prod.yml exec -T \
  -e MIGRATION_DATABASE_URL="postgresql://nexus:<pw>@postgres:5432/nexus" \
  api npm run db:migrate
```

```bash
# Or apply a single file directly, which needs no credentials from the host.
docker exec -i nexus-postgres-1 psql -U nexus -d nexus -v ON_ERROR_STOP=1 -f - \
  < packages/db/migrations/0NN-name.sql
```

`ON_ERROR_STOP=1` matters: without it psql reports success after a failed
statement, which on this platform means a migration that changed nothing and a
deploy declared finished on the strength of it.

Two failures worth recognising, because both were mistaken for the other:

| Message | Cause |
|---|---|
| `Query touched tenant-scoped table "..." with no tenant context` | The runner is not wrapping files in `withAllTenants`. Fixed 2026-08-14 — see `migrate.ts`. If it returns, migrations are running unscoped, and any write to a tenant-scoped table would match **zero rows without erroring** |
| `permission denied for schema public` (42501) | Running as `nexus_app`. Use the owner, per above |

`migrate.ts` now refuses to start when the connected role has no CREATE on
`public`, and names the role and the fix, rather than failing partway through
the file list.
