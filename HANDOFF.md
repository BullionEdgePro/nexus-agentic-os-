# Nexus Agentic OS — Session Handoff

**Written 13 August 2026.** Everything below was measured on the live system, not inferred.
Production: `nexusagenticos.com`, VPS `srv1859576` (`200.141.5.204`), deploy dir `/opt/nexus`.

---

## 1. How to reach production

**Use SSH. Do not use the Hostinger web terminal.**

```bash
ssh root@200.141.5.204
```

The key lives at `~/.ssh/id_ed25519` (comment `claude-code-nexus`); its public half is in the
VPS `authorized_keys`. Requires `Bash(ssh root@200.141.5.204 *)` in `.claude/settings.local.json`
— **settings are read at session start, so a permissions edit needs a restart to take effect.**

The web terminal drops after roughly a minute and, worse, **replays stale scrollback**: it will
show output for a command that never ran. That happened three times in one session and produced
three false "successes". SSH cannot do this.

## 2. Deploying

Two repos. Local `C:\CLAUDE CODE` (monorepo, `nexus-agentic-os/` subdir) pushes to `kova-audio`.
The VPS pulls from a **flat** repo: `github.com/BullionEdgePro/nexus-agentic-os-` (trailing dash).

```bash
# 1. commit + push the monorepo
git -C "C:/CLAUDE CODE" push origin main

# 2. mirror the subtree into the flat repo
NAO=<working copy of nexus-agentic-os->
git -C "$NAO" rm -rq --cached .
find "$NAO" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "C:/CLAUDE CODE" archive HEAD:nexus-agentic-os | tar -x -C "$NAO"
git -C "$NAO" add -A && git -C "$NAO" commit -m "..."

# 3. THIS is the part that breaks: gh is logged in as Rancho-Felipe, which has
#    no write access to BullionEdgePro, and it hijacks all github.com auth.
git -C "$NAO" -c credential.helper= -c credential.helper=manager push origin main

# 4. on the VPS
cd /opt/nexus && git pull --ff-only origin main
docker compose -f docker-compose.prod.yml build api worker
docker compose -f docker-compose.prod.yml up -d api worker
```

A fresh clone of the mirror also needs `git config user.email/user.name`, or the commit fails
with "Author identity unknown".

**Migrations run as `nexus`, not `postgres`** (that role does not exist):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U nexus -d nexus -v ON_ERROR_STOP=1 < packages/db/migrations/0NN-x.sql
```

Never read the exit code through a pipe — `... | tail -3; echo $?` reports the exit code of
`tail`, so a failed migration prints `0`. Redirect to a file and echo `$?` directly.

## 3. Verification — run these, trust nothing else

```bash
cd /opt/nexus && docker compose -f docker-compose.prod.yml exec -T worker \
  npx tsx apps/api/src/scripts/<gate>.ts
```

| Gate | Asserts |
|---|---|
| `self-check` | The shipped features still work end to end, against the real database |
| `schema-check` | Every previously-unrun query plans against the real schema |
| `rls-verify` | Policies on; other tenants hidden; own rows not hidden |
| `rls-preflight` | Every path carries a tenant context; auth routes establish their own |
| `retrieval-check` | 18 probes each find their page in the top 3 |

Last full run (15 Aug 2026, after the F10 deploy): **all five PASS**, 6/6 containers up, 625 tests,
typecheck clean. `schema-check` now also covers every F10 query, including the writes — inside a
transaction it rolls back, because `procedures` grants no DELETE and a probe row could never be
cleaned up.

**One flake worth knowing about.** `self-check` aborted on its first run with a connect timeout to
Google's embedding endpoint (`172.217.113.4:443`), one line after a retrieval had succeeded, and
passed cleanly on retry. Nothing to do with F10 — but embeddings are on the live reply path, so if
retrieval starts failing intermittently, VPS egress to Google is the first place to look rather
than the index.

## 4. State of the system

**Complete (7/15):** Employee Agent Layer · Knowledge Ingestion · Lead Intelligence · Security &
Tenant Isolation · Campaign Engine · Appointment Booking · Shared Intelligence (F5).

**In progress — F10 Procedural Memory. Live since 15 August 2026**, migration 034 applied, all five
gates green afterwards, `procedures` still at 0 rows. The first scheduled inference runs
**16 Aug 00:00 UTC** (04:00 Dubai); the queue's repeat key is registered in Redis. What shipped:

* **The inference writer** — `apps/api/src/services/procedure-inference.ts`, daily on its own
  queue. Reads conversations no human joined, where the customer kept replying after the agent's
  answer and the thread has been quiet a day; needs **5** of them for one kind of enquiry before it
  will call a procedure a procedure. Excludes `unknown` and `inbound_pitch` for the same reason F5
  does. Output is checked against the PII scanner **and** against the names of the customers it was
  drawn from — a hit throws the whole inference away, because a procedure goes into the prompt for
  every future customer of that business.
* **The review screen** — `/deck/procedures` ("How we answer"), addressed per organization like
  Knowledge, so `requireTenantScope` and the tenant middleware apply and RLS is doing real work.
  Activate, edit, accept, dismiss, or write one by hand.
* **Migration 034** — `proposed_steps`, dismissal memory, review stamps, one inferred row per
  situation.

**Measured on deploy day, so nobody re-derives it:** of Zipicka's 13 conversations in the last 60
days, exactly **1** is evidence this writer will use — and the reason is not the strictness of the
filter. Seven carry no intent at all (historical rows from before the intent vocabulary landed) and
five are spam or `unknown`, which is 12 of 13 before any of the conversation-shape rules are
applied. F10 is gated on intent coverage exactly as F5 was, and grows from here as classified
traffic accumulates. An empty screen for the next few weeks is the correct output.

Three rules are load-bearing and each has a test: the writer never activates anything; it proposes
to an active procedure rather than editing it; a dismissed suggestion needs **double** the evidence
before it may ask again.

**Still to do on F10:** wiring active procedures into the agent prompt, and `times_applied` /
`times_succeeded` (columns exist, nothing increments them). Until that lands, an activated
procedure is recorded and reviewed but does not yet reach a reply.

**Blocked on Meta, not code:** business verification is *in review* (~2 working days). Lifts
messaging limits; does not block drafting. All five templates are **Active**, and
`syncAllTemplates()` has run against the live API (7 approved per business, 0 retired).

**Blocked on reality:** F11 Predictive BI needs data volume that will now accumulate.
F13 Marketplace needs a data-egress policy decision.

**Partial by design, not neglect:** F14 measures quality but will not act automatically — judging
whether an escalation rate is wrong needs business knowledge. F8's operators call no model at all,
keeping monitoring cost at zero.

**Still to do by hand:** publish the four deep links (truecopyattestions.com, jurisprimelegal.ae,
sfsintrealestate.com, abshlaw.com). Highest-value item available; all 18 retrieval probes pass
against them. Without them every customer lands in the triage menu first.

## 5. Rules this codebase learned the hard way

**`DB_TENANT_ASSERT=strict` is live.** An unscoped query against a tenant-scoped table now throws.
Every new query needs its `withTenant` / `withAllTenants` wrapper from the first commit. Rollback:
`cp /opt/nexus/.env.bak-before-strict /opt/nexus/.env`, then restart api and worker.

**Adding a tenant table means adding it to `TENANT_SCOPED_TABLES`** in `packages/db/src/client.ts`.
Miss it and the guard silently does not cover the table.

**Put guarantees where they cannot be forgotten.** Double-booking is a gist exclusion constraint in
Postgres, not an application check — read-then-write races, and both customers are told they have
the slot while nothing errors. Catch the constraint violation and turn it into "that slot has just
been taken". Do not re-implement the check.

**Design the boundary into the schema when you can.** F5's shared store is safe because its columns
hold only counts and category labels — there is nowhere to put a customer's affairs. F10's
procedures could not be built that way (a procedure *is* prose), so it is strictly tenant-scoped
instead. Two law firms answer on the same number; neither may reply using the other's method.

**A check must run where the caller stands.** `self-check` asserted employee sign-in from inside
`withTenant(...)`, inheriting a context the unauthenticated HTTP route can never have — and passed
on every run while sign-in was broken for every employee in production. Use `withoutTenant()` for
probes of unauthenticated paths. Note `withTenant` opens a transaction, so a probe row created
inside one is invisible to another connection: commit before reading it back.

**A gate whose coverage is a hand-maintained list certifies its own blind spot.** `rls-preflight`
walked 13 listed paths; the one that mattered was not among them. Derive targets where possible.

**Strip comments before matching code.** A doc comment mentioning a table name is not a query.
Two separate false positives came from this.

**Do not assert adjacency in tests.** A test requiring `"tasks"` to sit directly after
`"contact_memory"` failed when an unrelated table was inserted between them — reporting a
regression that had not happened. Assert membership. A test that breaks when something correct is
added trains people to ignore it.

**A background writer must not edit what a person approved.** F10's writer runs nightly over the
same table a human reviews. Overwriting an active procedure would change how a business answers its
customers with nobody asked — and the row would still read "active", so the screen would still show
it as reviewed. The newer inference goes to `proposed_steps` instead. The general form: when a job
and a person write to the same row, the job gets its own column.

**A refusal has to be remembered, or the queue becomes wallpaper.** Migration 027 made this point
about findings that only ever accumulate. A nightly writer that re-proposes what somebody rejected
yesterday is the same failure: `dismissed_evidence` stores how strong the case was when it was
turned down, so "it has been a while" is not enough to ask again.

**Check the artefact, not the screen.** Every defect found in this session presented as normal
operation — no error, no alert, dashboards green. The sign-in that had never worked, a governance
judge dead behind a defaulted setting, Lorem ipsum indexed as knowledge, a permission file that
read correctly and parsed to nothing. All were found by verifying the produced result.

## 6. Next session

**First, look at what the writer produced overnight** — `/deck/procedures`, one business at a time.
On current traffic it will most likely have proposed nothing and said why, which is the designed
behaviour rather than a fault: Zipicka is the only business with customers, and the threshold is 5
well-handled conversations for one kind of enquiry. If the screen instead shows a suggestion,
**read the steps before anything else**: that is the first output of a model this platform has ever
put in front of a person as a proposal, and whether the steps are a method or a paraphrase of one
conversation is the judgement the whole feature turns on.

Note the deploy needed `web` rebuilt as well as `api` and `worker` — §2's recipe names only the
latter two, which is right for most changes and wrong for any that touch the deck.

Then say: **"continue F10 — put active procedures in front of the agent."**

That is the half that actually changes a reply, and it is deliberately last: the boundary landed
first, then the review, and only now the thing that speaks. Two decisions are waiting there — where
in the prompt a procedure sits relative to retrieved knowledge, and what increments
`times_applied` / `times_succeeded` without turning "the agent followed it" into "it worked".
