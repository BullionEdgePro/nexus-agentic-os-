# Running this thing

Everything below runs on the VPS from `/opt/nexus`. Scripts run inside the API
container, which already holds the database credentials — so none of them need
you to handle a password:

```bash
docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/<name>.ts
```

---

## Deploying a change

```bash
cd /opt/nexus && git pull origin main \
  && docker compose -f docker-compose.prod.yml build api web worker \
  && docker compose -f docker-compose.prod.yml up -d api web worker
```

**Migrations: which side of the deploy?** It depends on the change, and getting
it backwards causes an outage rather than an inconvenience. See the table in
`DEPLOY.md` — the short version is *if the diff adds a column name to a `select`,
run the migration first.*

Migrations are idempotent by convention here, so running one early is free and
running one late can cost messages.

```bash
U=$(grep -E '^DATABASE_URL=' .env | sed -E 's|.*://([^:]+):.*|\1|')
P=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker exec -i -e PGPASSWORD="$P" nexus-postgres-1 psql -U "$U" -d nexus \
  -v ON_ERROR_STOP=1 -f - < packages/db/migrations/<file>.sql
```

---

## The four checks, and what each actually proves

These exist because most tests in this repo read source text, and source text
cannot know whether a column exists, a query parses, or a policy returns
anything. Each of these runs the real code against the real database.

| Script | Answers | Run it when |
|---|---|---|
| `self-check` | Do the shipped features still work end to end? | After any deploy that touched the reply path |
| `schema-check` | Does SQL that has never executed actually work? | After adding or changing any query |
| `rls-preflight` | Does every path carry a tenant context, and is the guard live? | Before applying RLS policies |
| `rls-verify` | Do the policies *enforce*, or merely exist? | After applying them, and after adding a tenant |
| `retrieval-check` | Does each business's agent find the RIGHT page? | After re-indexing a site, and after changing a source list |

One query worth knowing about after migration 048, because no gate can answer
it and only production can:

```sql
select status, count(*), count(delivery_error) as with_reason
  from messages where direction = 'outbound'
   and created_at > now() - interval '24 hours'
 group by 1 order by 1;
```

Outbound messages are written `queued` and move to `sent` → `delivered` → `read`
as Meta reports. **If they all sit at `queued`, the account is not subscribed to
the `messages` webhook field** — check that before concluding that messages are
not reaching customers. The `delivery-failing` operator says the same thing in
its own detail text, and this is the query behind it.

`schema-check` writes to a probe contact and deletes it, and stops before
enqueueing anything — proving the bulk-send path works must not cost a customer
a WhatsApp message.

`retrieval-check` costs one embedding call per probe (18 today), so it is the
one to run deliberately rather than on every deploy.

`retrieval-check --lexical` asks a different question and costs nothing: how much
of the knowledge base is still reachable when the embedding provider is NOT. It
runs the same probes through the keyword fallback (migration 047) and prints,
for every miss, the wrong page it would have handed the agent. **It sets no exit
code on purpose** — failing when keyword search misses would assert that the
degraded path is as good as the real one, which is the opposite of what it is
for. Measured 17 August in production: **13 of 18**, where semantic search finds
all 18. Re-run it after any re-index rather than trusting that number; three
places in the codebase cite it, and a ratio quoted in a comment stops being
measured the moment it is written down.

Between them these found: an audience count filtering on a column that does not
exist, a broadcast insert whose parameter Postgres could not type (so no
broadcast could ever be created), and an upsert that erased fields. **None was
visible to any test in the suite.**

---

## Adding a business

```bash
docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/onboard-business.ts \
  --slug=acme --name="Acme Trading" --keywords="acme,trading,import" \
  --website=https://acme.ae
```

Writes nothing on the first run. It prints keyword collisions, which is the
point: keywords share **one namespace** across every business on the shared
number, and a word claimed twice routes to neither — the switchboard returns a
triage menu instead. Adding a tenant claiming `contract` degrades the law firm
that was working fine, and nothing at insert time would show it.

Read the collisions, then re-run with `--confirm`.

Afterwards: index their website on the Knowledge page, replace the placeholder
system prompt, and publish their link and QR from Customer Links.

---

## Filling out a business's knowledge

The Knowledge page handles one page at a time. To index a whole site — which is
what a newly-onboarded business needs — use:

```bash
docker compose -f docker-compose.prod.yml exec -T worker npx tsx apps/api/src/scripts/ingest-site.ts <slug>
```

Note this one runs in the **worker**, not the API, and takes the slug as a bare
argument. It crawls the business's own site and indexes what it finds.

Thin knowledge is the quietest failure the agent has: it still replies, fluently,
from its instructions alone, and nobody can tell it had nothing to answer from.
Check the passage count per source on the Knowledge page afterwards — a business
with three pages and eleven passages is not ready for customers.

---

## Adding an admin

```bash
docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/create-admin.ts \
  someone@example.com "Their Name"
```

Positional arguments, not flags — `onboard-business` takes `--flags` and this
one does not. Worth knowing before typing the wrong shape at it.

The password is generated server-side and printed **once**. It is never stored
in plain text and cannot be recovered — re-run the script to issue a new one.

---

## WhatsApp templates

```bash
docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/provision-templates.ts
```

Submits one utility template per business and syncs Meta's answer back. Safe to
re-run: an existing name comes back as a duplicate and is skipped.

Approval status syncs automatically every 30 minutes, and there is a **Check
Meta for updates** button on the Broadcasts page. `is_approved` is derived from
Meta's status in exactly one place and **nothing in the product may set it** —
the whole point is that the answer comes from the party who decides it.

---

## When something is wrong

**A customer messaged and got no reply.**
Check the worker, not the API — the webhook returns 200 and enqueues, so a
failure downstream is invisible from outside.
```bash
docker logs --since 30m nexus-worker-1 2>&1 | grep -iE "error|failed" | tail -20
```
Then `self-check`. The usual causes are an exhausted model quota, a retired
model id, or a query referencing something the schema does not have.

**Anything older than the last deploy needs `journalctl`, not `docker logs`.**
`docker logs` only ever shows the container that is running now, and
`up -d --build` REPLACES containers rather than restarting them. api and worker
log to journald (see `docker-compose.prod.yml`) precisely so their history
outlives that — but you have to ask journald for it:
```bash
journalctl CONTAINER_NAME=nexus-worker-1 --since "2 days ago" | grep -iE "error|failed"
journalctl CONTAINER_NAME=nexus-api-1 --since "2026-08-15" --until "2026-08-16"
```
This was added on 2026-08-17 after an unexplained message from two days earlier
could not be diagnosed at all: eight deploys that day had erased every worker log
covering it. If you are ever reading this while investigating something old, that
is the command.

**A page is empty that should have data.**
Almost always RLS running without a tenant context. `rls-verify` will say so.
Rolling back is one statement per table and destroys nothing — policies filter
reads, they never delete:
```sql
alter table <table> disable row level security;
```

**A deploy made things worse.**
```bash
cd /opt/nexus && git log --oneline -5
git checkout <previous-sha> && docker compose -f docker-compose.prod.yml up -d --build api web worker
```
Migrations are not rolled back by this. They are written to be additive and
re-runnable, so old code against a newer schema is normally fine — the reverse
is what breaks.

---

## What the platform cannot do without you

Written down because these look like engineering problems and are not:

- **Bulk sending** needs a payment method on the WhatsApp account and business
  verification. Both are done in Meta's tools. The engine is built and its
  database path is verified end to end; nothing further can be done from here.
- **A second business with customers.** Four of five have never had one message
  them. Several guards — the two-tenant learning threshold, per-business memory,
  the isolation check — cannot be evaluated at all until that changes.
  Publishing the links and QR codes is the cheapest way to change it.
