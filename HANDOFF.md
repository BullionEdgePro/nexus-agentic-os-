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

Last full run (15 Aug 2026, after F10 was completed): **all five PASS**, 6/6 containers up, 638
tests, typecheck clean. `schema-check` now also covers every F10 query, including the writes — inside a
transaction it rolls back, because `procedures` grants no DELETE and a probe row could never be
cleaned up.

**F11 has NOT been through these gates yet — it is built and unshipped.** Locally: typecheck clean,
**673 tests pass / 0 fail** (35 new), `next build` clean. `schema-check` has been extended to cover
every F11 query and has not been run, because it needs the real database. Run it first, before the
migration is considered done: it is the only thing that has ever caught SQL that Postgres could not
plan. Its F11 section **forces the INSERT** rather than calling `produceForecasts` and accepting a
quiet zero — the writer refuses on thin history, which every business currently has, so the natural
call would plan the reads, write nothing, report success, and leave the insert as unverified as it
was until the first business finally accumulated traffic.

**One flake worth knowing about.** `self-check` aborted on its first run with a connect timeout to
Google's embedding endpoint (`172.217.113.4:443`), one line after a retrieval had succeeded, and
passed cleanly on retry. Nothing to do with F10 — but embeddings are on the live reply path, so if
retrieval starts failing intermittently, VPS egress to Google is the first place to look rather
than the index.

## 4. State of the system

**Complete (8/15):** Employee Agent Layer · Knowledge Ingestion · Lead Intelligence · Security &
Tenant Isolation · Campaign Engine · Appointment Booking · Shared Intelligence (F5) · **Procedural
Memory (F10)**. **Built but not yet deployed: Predictive BI (F11)** — see below.

**F10 went live on 15 August 2026** — migrations 034 and 036 applied, all five gates green
afterwards, `procedures` at 0 rows. The first scheduled inference runs **16 Aug 00:00 UTC**
(04:00 Dubai); the queue's repeat key is registered in Redis. All three parts shipped:

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
* **The reply path** — `packages/agents/src/procedure-recall.ts`, called from the processor
  alongside memory, follow-ups and appointments, and prepended **last** so the instruction sits
  nearest the customer's message. Selection runs on the message text alone, because
  `classifyIntent`'s better signal — the tool the agent called — does not exist yet at that point.
  The note says the order is a default rather than a script, that it never licenses a fact
  retrieval did not supply, and that it must never be read out to the customer.
* **The counters** — `times_applied` / `times_succeeded` are **derived hourly** from a
  `procedure_id` stamped on the metric row, never incremented. The stamp is written even when
  governance blocked the reply; excluding escalations would make "ended without a human" true by
  construction.
* **Migrations 034 and 036** — `proposed_steps`, dismissal memory, review stamps, one inferred row
  per situation; then the applied-procedure stamp. **036, not 035**: another workstream took that
  number for `035-reengagement.sql` mid-change, and the one that had been applied nowhere is the one
  that moved.

**Measured on deploy day, so nobody re-derives it:** of Zipicka's 13 conversations in the last 60
days, exactly **1** is evidence this writer will use — and the reason is not the strictness of the
filter. Seven carry no intent at all (historical rows from before the intent vocabulary landed) and
five are spam or `unknown`, which is 12 of 13 before any of the conversation-shape rules are
applied. F10 is gated on intent coverage exactly as F5 was, and grows from here as classified
traffic accumulates. An empty screen for the next few weeks is the correct output.

Four rules are load-bearing and each has a test: the writer never activates anything; it proposes
to an active procedure rather than editing it; a dismissed suggestion needs **double** the evidence
before it may ask again; and nothing in the UI calls the containment count success.

**The one link never exercised end to end**, stated rather than left to be assumed: no real
customer message has yet met an active procedure, because there are none. `schema-check` proves the
lookup, the stamp and the rollup against the live schema, and the processor wiring is covered by
tests over the source — but the first genuine proof will be a conversation. Activating a procedure
is a live change to what customers are told, so it wants a person's decision, not a deploy step.

**Blocked on Meta, not code:** business verification is *in review* (~2 working days). Lifts
messaging limits; does not block drafting. All five templates are **Active**, and
`syncAllTemplates()` has run against the live API (7 approved per business, 0 retired).

**F11 Predictive BI is built and not yet deployed (15 Aug 2026).** Migration 037, a `forecasts`
table, a daily queue, `/api/organizations/:slug/forecast`, and a deck screen at `/deck/forecast`
("What's coming"). Seven-day demand forecasts per business — conversations, and conversations
needing a person — from `agent_quality_daily`, by weekday median. **It calls no model**, for the
same reason F8's operators do not and one more: a model asked for a number always returns one and
cannot be asked for its error distribution, which is the only part of a forecast worth having.

The reason this is not the numerology the architecture doc warned about, in one line each:

* **It refuses more often than it speaks, and says which constraint binds.** Four weeks of history,
  ten days with actual traffic, fourteen days of rolling-origin backtest. The all-zero series gets
  its own named refusal, because four of five businesses have one — it passes every length check,
  backtests perfectly (predicting zero is always right), and would otherwise render a confident flat
  forecast with a tight interval and a glowing accuracy score. That output is not useless; it is
  convincing, which is worse.
* **Every claim is written down before its day, with the naive baseline beside it.** "The same
  weekday last week" is stored at prediction time, not recomputed later, so "was this worth running?"
  is arithmetic. When the naive guess wins, the screen says so in the same size type.
* **It cannot mark its own homework.** The backtest predicts each past day from only the days before
  it. The *live* accuracy figure counts only rows whose `made_at` precedes the start of the day they
  describe — enforced in the writer's SQL *and* again in the read, so a hand-inserted row can exist
  and can never earn a score. Accuracy is never totalled across horizons: averaged, it would improve
  whenever the job ran late.
* **The table cannot forget its misses.** No DELETE grant. A reporting feature able to drop its own
  wrong rows reports 100% forever.

**What it will show on Monday: nothing, everywhere, with a sentence.** Zipicka has weeks of history
and 13 conversations in 60 days; the other four have no customers. Every metric is expected to
refuse. That is the designed output and the screen is built around it — same shape as F10's empty
review queue, and the same instruction applies: do not read the empty state as a fault.

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

**A measurement whose denominator excludes its own failures cannot go down.** F10 stamps the
procedure that shaped a reply even when governance blocked that reply and handed the conversation
to a person. Recording only the replies that went out would have been the tidier code and would
have made "ended without a human" true of nearly every stamped conversation — a success rate that
rises to 100% and stays there, on a feature whose whole purpose is to be judged. Before trusting
any rate on this platform, look at what was left out of the bottom of the fraction.

**A refusal has to be remembered, or the queue becomes wallpaper.** Migration 027 made this point
about findings that only ever accumulate. A nightly writer that re-proposes what somebody rejected
yesterday is the same failure: `dismissed_evidence` stores how strong the case was when it was
turned down, so "it has been a while" is not enough to ask again.

**Record the dumb alternative at the same instant, or you can never find out.** F11 stores what "the
same weekday last week" said in the same row as the forecast, written at the same moment from the
same data. Recomputed afterwards, the comparison would be made from information the baseline never
had, and the method would win by construction. The general form: when you ship something clever,
write down what the obvious thing would have said, at the time, in the same place — otherwise "was
this worth building?" becomes a matter of opinion, and the opinion belongs to whoever built it.

**A prediction that has not been written down in advance is a memory.** F11's accuracy figure counts
only rows whose `made_at` precedes the start of the day they describe. The guard is in the writer's
SQL *and* repeated in the read, because a guard in one place holds until somebody inserts a row
another way. A backdated row can exist in that table; it can never earn a score. Note what could not
be done: this is exactly the case for a CHECK constraint, and a CHECK containing `now()` is not
re-evaluated against rows already stored — so it would look like a guarantee and behave like a
suggestion. When the database cannot hold the guarantee, put it in the read path, not the caller.

**A denominator that grows when the job runs late is not an accuracy.** F11 groups its error by
horizon and refuses to total across them. A claim made overnight and one made six days out are
different claims of different difficulty; averaged together, the published figure improves every time
the scheduler slips. Same family as migration 019's warning about what gets left out of the bottom of
a fraction.

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

**F10 is finished and needs traffic, not code.** Its remaining risk is not in the writer or the
screen; it is that nobody has yet watched a real customer meet an active procedure. When the first
one is switched on, read the next few replies in the inbox before trusting it — the specific thing
to look for is the agent working through the steps like a form on a customer who had already
answered half of them, which the note explicitly warns against and which a prompt cannot guarantee.

**The highest-value item available is still not code:** publish the four deep links
(truecopyattestions.com, jurisprimelegal.ae, sfsintrealestate.com, abshlaw.com). All 18 retrieval
probes pass against them, and without them every customer lands in the triage menu first.

**F11 is written and unshipped, and shipping it is four steps.** Push to both repos, apply migration
037 as `nexus` via psql (never through `db:migrate` — see §2), rebuild **api, worker AND web**, then
run `schema-check` before believing anything. The web rebuild is not optional here: this change adds
a deck screen, and §2's recipe names only api and worker.

When it is up, the thing to look at is not the forecast. **It is whether the refusals name the right
constraint.** Open `/deck/forecast` for each business in turn and read the sentence under each
heading. Zipicka should say it has too few complete days or too few active ones; the other four
should say they have had no customer conversations at all. If any of them instead shows seven
confident bars, stop and look at why — on this much traffic that is not good news, it is the failure
this feature was shaped to prevent, and it would look exactly like success.

The first genuinely informative moment is roughly four weeks after Zipicka crosses the thresholds,
when `MIN_SCORED_FORECASTS` is met and the earned accuracy table appears for the first time. Read the
baseline column before the method column. If the naive guess is winning, the honest thing is to say
so on the screen — which it already does — and the honest fix is a better method, not a wider
interval.

Beyond that, F5 is gated on the same thing, and every one of these gets better as intent coverage
does, which makes the intent classifier the load-bearing part of the next three features rather than
any one of them.
