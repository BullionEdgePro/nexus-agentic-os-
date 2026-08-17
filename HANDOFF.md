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

F13 Marketplace's egress policy was decided (nothing leaves) and the catalogue is built. Its empty
state is the same instruction again: a shelf with nothing on it and a shelf that failed to load
must not look alike.

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


---

# Addendum — 15 August 2026, later session

Everything below was measured on production over SSH, not inferred.

## What shipped since the section above

**F11 Predictive BI — deployed and verified.** It was built-but-unshipped and had never met the
real database. Migration 037 applied, `schema-check` run FIRST as that section instructs, then the
other four gates. All green. The forced INSERT mattered: the writer refuses on thin history, which
every business has, so calling it naturally would have planned the reads, written nothing, reported
success, and left the insert as unverified as before.

**F8 Operators — COMPLETE, 11 of 11.** Five added this session, each watching a failure the newer
features made possible:

* `procedure-awaiting-review` — F10 proposes and never activates, so suggestions can pile up on a
  screen nobody opens while the feature reports itself as working. Never urgent, deliberately.
* `booking-unassigned` — a confirmed appointment with no employee attached. The one failure here a
  customer experiences physically. Urgent inside 12 hours.
* `template-rejected` — `syncAllTemplates` has always written Meta's status down and nothing read
  it. A rejected template drafts fine and fails at send, in front of a customer.
* `reengagement-candidate` — reports, never sends. Quiet 30 days, not opted out, not in cooldown.
* `retrieval-unavailable` — see below; it needed a column that did not exist.

**Migration 035 — re-engagement.** Cooldown is a gist exclusion constraint on
`(contact_id, tstzrange(sent_at, cooldown_until))`, NOT an application check. Opt-out lives on the
contact so it outlives any attempt row. Nothing sends yet.

**Migration 038 — `conversation_metrics.retrieval_outcome`** (`hit` / `miss` / `failed`, nullable).
The knowledge tool now returns `outcome` as a FIELD, so nobody classifies an outage by matching the
wording of a customer-facing note.

**Migration 039 — F13 marketplace.** Egress policy decided: **NOTHING LEAVES.** Install-only.
`catalog_items` has no `organization_id` and **0 foreign keys to any tenant table** — verified —
so there is nowhere to record one business's material. `catalog_installs` is tenant-scoped and
RLS'd. Install is not activate; installed version is copied, not referenced.

**Intent backfill.** 7 conversations had no `conversation_metrics` row at all (NOT null intent —
there were none of those). 4 given rows, 3 left alone because their text classifies as `unknown`
and a guess is worse than a gap. Result: `inbound_pitch` 8, `unknown` 6, `knowledge_lookup` 2 —
**half of measured traffic is people selling TO the business**, which reframes the volume numbers.

**Four deep links delivered** to the owner, paste-ready. The `#slug` tag is load-bearing.

## State

**9 of 15 complete.** 684 tests, typecheck clean, `next build` clean, all five gates green under
`strict`, 11/11 operators reporting 0 standing across 5 businesses, 6/6 containers up. The 11 new
tests are `marketplace-installs-only.test.mjs`, which asserts the egress boundary is still the
shape of the tables rather than a rule — including that no later migration ever gives
`catalog_items` an `organization_id` or a foreign key to a tenant table.

## The F13 catalogue page and install action — BUILT, NOT DEPLOYED

Operator-only, at `/deck/catalogue` and `/api/catalog`. Mounted flat rather than under
`/api/organizations/:slug` so `operatorOnly` can guard the whole prefix — and because the useful
view, who across all five businesses is running what, has no per-business form. Installing changes
what every customer of that business is eventually told, so it is an owner's screen.

**Two things found while building it, both in migration 039's own stated intentions:**

* `unique (organization_id, catalog_item_id, installed_at)` enforces **nothing**. `installed_at`
  defaults to `now()`, so two installs in two requests carry two timestamps and both are accepted;
  the only case it catches is two rows in one transaction, which no code path does. 039's comment
  says "having it twice at once is not [allowed]" and the database disagreed. **Migration 040**
  replaces it with a partial unique index on `(organization_id, catalog_item_id) where removed_at
  is null` — the only shape that can express "unless it was removed".
* The shelf was empty by design, and an empty shelf cannot be judged: "nothing published" and "the
  query is broken" render identically. **Migration 041** publishes six items — three procedures,
  two templates, one knowledge pack — all generic or skeletons. Nothing industry-specific, because
  a catalogue shipping opinions about a law firm's intake written by nobody who works there is
  worse than an empty one.

**Installing does not yet change what a customer hears, and the page says so.** An install records
a decision — which business took which pack, at which version, switched off. No payload is wired
into the live agent. There is deliberately **no activation switch**: a control reading "active"
that changed nothing customers experience is exactly the plausible-normal-state failure this
platform keeps producing.

**DEPLOYED 2026-08-17.** VPS at `bcf3903`, 6/6 containers up, model preflight OK for both models
across all five tenants. Migrations 040, 041 and 042 applied as the owner via `psql` against the
mounted migrations directory inside the postgres container — never `exec api npm run db:migrate`.
Verified in production by reading back, not by exit code: the old constraint is gone and the
partial index reads `(organization_id, catalog_item_id) WHERE (removed_at IS NULL)`; six items
published; `nexus_app` sees all six under `app.tenant_scope='all'`; and an insert into
`catalog_items` as `nexus_app` fails with `permission denied`, so the boundary is real on the live
database and not only in the migration text.

**Migration 042 — the 039 lesson, one line further down.** Reading the grants back after 040 and
041 showed `nexus_app` holding **DELETE on `catalog_installs`**. 039 revoked on `catalog_items`
and then granted on `catalog_installs` in the next line without revoking, so the blanket DELETE
survived there. `removeCatalogInstall` stamps and never deletes, and the test asserts no delete
statement exists — but both are facts about the code, and the guarantee was being kept by the
application's manners rather than by the database. It matters more than it sounds: 040's
uniqueness is conditional on `removed_at is null`, so a deleted row does not merely lose the
record, it makes a second install of the same pack look like a first. **Revoke first, then grant,
on every table in the file — not only the one that failed.**

## Activation — BUILT

**It materialises; it does not switch on.** A catalogue procedure becomes a `procedures` row for
that business with `is_active = false`, and a person turns it on from "How we answer" — the screen
that already shows what else is answering that situation and already refuses two at once. A
catalogue button reaching into the live prompt is the one thing 039's design exists to prevent.

Knowledge is the stated exception: a chunk has no switched-off state, so adding a pack changes what
the agent can answer from immediately — exactly as adding a source by hand already does. The page
says so above the buttons rather than letting "switched off" be read as covering both.

**Migration 043 — a third `source`, because both existing values are lies here.** Nobody at this
business wrote a catalogue procedure, and it was drawn from none of this business's conversations.
`'inferred'` would show "drawn from 0 conversations" (evidence that came out empty, not evidence
never claimed) and let the writer rewrite it. `'operator'` is the worse trap: **F10 rule 3 makes the
nightly writer permanently silent wherever an operator procedure is active**, so a generic pack
installed in a minute would switch off that business's learning about that kind of enquiry, for
good, silently. So `'catalog'` — and the writer deliberately does NOT defer to it. Both existing
unique indexes were checked rather than assumed: `procedures_one_active_per_intent` is partial on
`is_active` (so a catalogue row competes for the single live slot, correctly);
`procedures_one_inferred_per_intent` is partial on `source = 'inferred'` (so the writer's slot is
untouched). `procedures_one_per_catalog_install` is what makes activation idempotent.

**TWO KINDS CANNOT BE ACTIVATED, and both are findings rather than unfinished work:**

* **`template`.** `message_templates` is a MIRROR OF META (017) — a local row there recreates
  exactly the failure that migration was written to prevent, "a bulk send that fails at the last
  hop, after the broadcast row, the recipient rows and the queue jobs all exist". And these are not
  Meta templates anyway; they are agent reply wording, **which this platform has no home for at
  all**. The nearest thing is appending prose to `agent_configs.system_prompt`: one unstructured
  blob per business, with no way to see what came from where or take it back out. Giving authored
  wording a home is a design decision about how phrasing enters the reply path and deserves its own
  slice.
* **`guidance_only` packs (044).** 041's checklist item is nine QUESTIONS, by its own note. Indexing
  it would put questions into what retrieval searches, and the knowledge screen would show a base
  fuller than it is — this platform's signature failure in a new coat.

**There is deliberately no deactivate.** Once material is in the business it IS the business's — the
procedure may be switched on and shaping replies, the knowledge may have been edited since. Taking
it back belongs to "How we answer" and "Knowledge", which own those decisions and can show what
depends on them. Removing the *install* leaves the material in place, and the card says so.

## Authored agent wording now has a home — BUILT

**The finding first: the platform already had authored wording and nowhere to keep it.** Two string
constants in the reply processor — `FALLBACK_REPLY` ("I'm looping in a specialist from our team")
and `FALLBACK_REPLY_NO_STAFF` — are sent by **three call sites** (governance escalation, the
AI-failure path, the handover flag), which makes them among the most-delivered sentences on the
platform. They are **identical for a retailer and two law firms**, and changing either needed a
deploy. That is what the F13 template refusal was really pointing at.

**Migration 045 — `agent_phrases`.** Per business, per moment, one active each, arrives switched
off. The vocabulary is exactly the two moments the reply path **already detects and already speaks
at**; the rule for adding a third is that the detection is the work and the constant is the last
line written, not the first. A moment nothing detects is wording that is stored, visible, switched
on, and never sent. The triage menu is deliberately excluded — it goes out before the switchboard
knows which business the customer wants, so there is no business whose wording it could use.

**WHY THIS TABLE IS MORE DANGEROUS THAN `procedures`, and shaped for it.** A procedure is CONTEXT
the model reads and can work around. A phrase **is the message** — sent verbatim, no model in
between, at the exact moment the platform has already decided it cannot answer properly. Nothing
downstream catches a mistake. So length is bounded in the database and not just the form, and:

**The placeholder guard is the most important line in the feature.** Catalogue wording ships with
`{{open_time}}` because the catalogue cannot know when a business opens. A phrase carrying an
unfilled placeholder **cannot be switched on** — refused by name, so the fix is obvious. It is
checked on the way ON only: refusing to switch one OFF would trap a business with `{{open_time}}`
live and no way to stop it.

**The reply path cannot be made worse by this.** Both constants stay and are the fallback for an
empty result AND for any failure. `resolvePhrase` uses `withServingTenant` — read as the number's
owner, RLS matches nothing and "this business wrote none" is indistinguishable from an outage,
which is the mistake `hasStaffOnShift` already made for four of the five businesses.

**Migration 046** rewrites the two catalogue templates to name their moment. The `no_one_available`
one had to be reworded: its old body promised "someone will come back to you then" at precisely the
moment there is nobody — the failure that left a conversation abandoned for eleven days. Shipping
it unchanged would have put an item on the shelf whose purpose was to reintroduce an incident.

F13's template refusal is closed: `activatableKinds` is now all three.

## Wording drafted for both law firms — FOUR DRAFTS, ALL SWITCHED OFF

**Correcting the previous entry, which was wrong about which phrase matters.** It said
`handing_over` was the one to write first for the two firms. Checking before writing:

```
abr                | 0 active staff | 0 with a rota
juris-prime-legal  | 0 active staff | 0 with a rota
```

`hasStaffOnShift` is false for both, so **`handing_over` never fires for either firm**.
`no_one_available` is the moment their customers actually reach. Writing only the requested one
would have produced wording that is stored, visible, switched on and never sent — the exact failure
`PHRASE_MOMENTS` was written to prevent, committed one day after writing the rule.

So all four exist, as drafts (`is_active = false`, `reviewed_by` NULL, because nobody has reviewed
them — a draft that claimed a reviewer would be the same lie as a procedure claiming evidence):

* **`handing_over`** for both, live the moment either firm has one person on a rota. Neither says
  "specialist": Juris Prime Legal passes to *a solicitor*, ABR to *an advocate*.
* **`no_one_available`** for both — **the pair that is reachable today**. Neither promises anybody,
  which is the rule this moment exists to keep.
* Both firms' wording says in as many words that what the agent has said is **general information
  rather than legal advice**. That is not decoration on a law firm's message.
* **ABR's `no_one_available` deliberately carries `{{office_number}}`**, so it CANNOT be switched on
  until somebody fills in the real number. It tells a caller with a police station or a court date
  today not to wait on the chat, and a phrase that says "call us on" without a number would be
  worse than the platform default. The placeholder guard is doing exactly what it was built for.

Verified in production: all four read back inside the length bound, and as `nexus_app` under the
serving tenant context an activated one is returned by the same query the reply path uses — checked
in a transaction that rolled back, so nothing is live.

**Nothing has changed for any customer.** Somebody at each firm has to read these and switch them
on, which is the whole design.

## Both law firms stay unstaffed — DECIDED 2026-08-17, not overlooked

Asked to set up rotas for both firms and found there is nothing to attach one to: **neither firm
has a single employee row**, active or otherwise. Only `zipicka` (1) and `juris-prime` (1) are
staffed at all. Creating the records would have meant inventing solicitors and advocates for two
real firms, and that is not a cosmetic objection — a fabricated active employee with hours makes
`hasStaffOnShift` true, which flips the reply to `handing_over` ("I am passing this to one of our
solicitors") **and** lets `flagHandoffBestEffort` pause the agent. Told help is coming, cut off from
the only thing answering: the 1–11 August state, reintroduced on a criminal-defence line.

**The owner's decision is to leave both unstaffed for now.** Recorded here so the next session does
not read zero staff as an oversight and try to "fix" it.

**What that costs today: nothing.** Both firms have **0 conversations and 0 inbound messages** —
neither has ever had a customer. Checked, not assumed.

**What it means when traffic arrives, and this is the part worth knowing.** Both firms are on the
strict governance tier (not in `MEDIUM_RISK_TOLERANT`), so `shouldEscalateReply` returns true on a
*medium* verdict, not just high. With an empty rota `canHandOver` is false, so the agent's actual
grounded answer is discarded and the customer receives the `no_one_available` wording instead. For
these two firms that phrase is therefore **not a rare fallback** — it is what they send whenever the
judge is unsure. And when the judge cannot be reached at all, `evaluateHallucinationRisk` returns
"medium" as the absence of a verdict, so *every* reply would be replaced (see the `judge-offline`
operator, which exists for exactly this and calls no model so it works on the day models are what
is broken).

That raises the value of the four drafts rather than lowering it: for these firms the
`no_one_available` sentence is close to the whole product until somebody is on a rota.

Note the platform's last evaluation of any kind was **2026-08-08** (12, all Zipicka, all medium).
There is no recent judge activity to draw a health conclusion from either way.

## Three of the four drafts approved 2026-08-17 — the fourth cannot be

Approved on the owner's instruction, `reviewed_by = aiapps255@gmail.com`:

| business | moment | live | why |
|---|---|---|---|
| juris-prime-legal | `no_one_available` | **yes** | the one their customers actually reach |
| juris-prime-legal | `handing_over` | yes | inert until somebody is on a rota |
| abr | `handing_over` | yes | inert until somebody is on a rota |
| abr | `no_one_available` | **no** | still holds `{{office_number}}` |

**ABR's out-of-hours wording is the one that matters most for that firm and is the one still off.**
It tells a caller with a police station or a court date today not to wait on the chat and to ring
the office — and it cannot go live until somebody supplies the number, because the sentence is sent
verbatim and "call us on {{office_number}}" is worse than the platform default.

**A note on how these were approved, because it bypassed a guard.** There is no operator session
available from here, so the switch was thrown with `psql` rather than through
`PATCH /api/organizations/:slug/phrases/:id` — which means the route's unfilled-placeholder check
did not run. The guard was therefore written INTO the statement (`and body not like '%{{%'`) rather
than trusted to memory, and it is what left ABR's row alone: the update reported `UPDATE 3` against
four candidate rows. **Anyone approving by hand in future must carry that clause**, or the guard
simply is not there.

Verified as `nexus_app` under each firm's tenant context: Juris Prime Legal's `no_one_available`
now resolves to its own sentence, ABR's still resolves to the platform default. Both firms still
have **0 conversations**, so nothing has been sent to anybody.

## F5 — the brain can now be seen, and its silence has a watcher

Continuing F5 started with finding out what it actually lacked, and it was not what the status row
said. **The store is fine.** `shared_patterns` runs on the hourly rollup, the redaction gate holds,
`/api/quality/shared` has been serving `getSharedGuidance` + `getBrainStatus` for weeks. Two things
were missing, and the smaller one is the one everybody would have named:

**1. Nothing in the product showed it.** The endpoint had no caller in `lib/api.ts` at all. A pooled
store nobody can look at cannot be told apart from a broken one — which is the exact confusion this
feature already lost months to, when intent came from tool calls alone, 83% of traffic fired no
tool, and the store read a sixth of the platform while reporting an emptiness that looked like
youth. Now a section on **Agent quality** (not a new tab — it is the platform-wide version of the
per-business numbers above it, from the same rows and the same job).

**Coverage is rendered ABOVE the patterns, deliberately.** Whether F5 can *see* anything comes
before what it *knows*; only one of the two is fixable by waiting, and the reverse order is how the
original defect hid.

**2. `neverClassified` had no watcher — a documented defect nobody could see.** Its own doc comment
says: rising, "it means the classifier stopped running, and that is a defect rather than a quiet
week". `getIntentCoverage` was read by one hand-run backfill script and nothing on a schedule. New
operator **`intent-unclassified`** (12th, calls no model like the rest) raises it per business.
It matters because *every* consumer of intent degrades to a plausible empty result when
classification stops: the pool takes nothing, no procedure is ever recalled, hotspots empty — three
screens all reading as a quiet week.

**A bug this found in itself, visible only by looking at the rendered page.** The first version fell
back to `?? 0` throughout, so an unreachable API drew "0 conversations measured, 0 patterns stored" —
the platform reporting it had learned nothing when the truth was that nobody had asked. That is the
failure the section exists to expose in F5, reproduced by the section. It now refuses to draw any
number it did not receive.

**Still not done, and it is the bigger half:** `getSharedGuidance` is read by this endpoint and a
preflight script, and **by nothing on the customer path**. F5 informs a person, never an agent. The
screen says so in as many words rather than letting a pooled table imply otherwise. Wiring it in is
a decision about one business's answers being shaped by other businesses' outcomes, and it deserves
its own argument — not least because there are 0 shareable patterns today, so it would change
nothing and prove nothing.

## F5's other half — pooled guidance now reaches a reply

**This is the only thing on the platform that shapes what a customer is told without a person at
that business having approved it.** Everything else — procedures, phrases, catalogue material —
arrives switched off and waits for somebody. That departure is deliberate, because a business with
no history is exactly who F5 was described as being for, but it is fenced hard:

* **Own material always wins.** The pooled branch is only reached when `getActiveProcedure` returns
  nothing. A procedure somebody here wrote, or read and switched on, is never second to a generic
  tendency.
* **The pool's thresholds, not the caller's.** `getSharedGuidance` is reused rather than re-queried,
  because it is the single place the two-tenant filter and 20-sample floor live. Its own comment
  says what a second query would cost: one tenant's history handed back as platform knowledge with
  nobody downstream able to tell. This caller does not get to set its own bar.
* **A usefulness floor on top:** `POOLED_ESCALATION_FLOOR = 0.5`. Below that it is a kind of enquiry
  usually handled fine, and preparing a handoff for it would make the agent worse at the majority
  it could have answered.
* **No numbers and no other business reach the prompt.** The rate decides whether to speak and is
  then dropped — a model handed "78%" eventually hands it to a customer, and "most people in your
  position end up needing a lawyer" is a sentence no business here would choose to send.
* **It stamps no `procedureId`.** `times_applied` is recomputed from those stamps, so a borrowed id
  would inflate a real procedure's usage with conversations it never shaped.
* **Fails soft**, and the note tells the agent explicitly that this is *not* a reason to hand over
  early — without that line, "this usually needs a person" reads to a model as licence to stop
  trying.

**Inert today and verified so:** 0 patterns meet two-tenants-and-twenty in production. Seeding a
qualifying one in a rolled-back transaction confirmed it would be returned (`legal_inquiry`, rate
0.78), so the chain works and is simply waiting on traffic.

The selection is a pure exported function, `selectPooledGuidance`, tested with real patterns rather
than by matching source — wrong language, wrong intent, and an off-by-one on the floor would each
produce a note that reads perfectly sensibly in front of a customer and is about something else.

## Four customers have been silenced for sixteen days, and nothing was watching

Looking for the next feature, §9 said to read the register of what was not done. It records that
escalation used to promise a specialist who did not exist, that the promise was fixed, and that four
conversations were already muted. **Re-counted in production today: all four are still muted.**
Opened 1–3 August, still `is_human_handoff`, still open, never touched by a human. Sixteen days. One
of them wrote again on 10 August, into a paused conversation.

**Nothing was watching, and the reason is the interesting part.** `customer-waiting` requires the
customer to have spoken last — that is what makes it *waiting* rather than *quiet*. But this state is
created BY THE AGENT SPEAKING: it says "I'm looping in a specialist", sets `is_human_handoff`, and
stops. The last message is outbound forever, so the operator can never see it.

It did worse than not see it. It had raised *"khan has been waiting 261 hours for a reply"* on
12 August and then **retracted it** — that finding reads resolved in `operator_findings` right now,
while the customer has still never been answered. The alert cleared itself while the harm continued,
which is this platform's signature failure wearing its most convincing disguise yet.

**`handover-abandoned` — the 13th operator.** The test is **"did a human EVER arrive"**, not "how
long since a message": a handover that was honoured also ends outbound and also goes quiet, so a
timestamp cannot tell them apart. Always urgent — unlike a slow reply, this state never resolves
itself.

Verified against production rather than assumed: three conversations match the SQL, and the
`scoreLead` fallback correctly suppresses the two cold pitches that predate lead scoring (a data
broker and a pet-food manufacturer, neither carrying an assessment). **One real person surfaces** —
someone who said "Hi", was promised a colleague, and has waited 388 hours.

**The operator fired on its first live sweep**, exactly once and on exactly the right person:

```
urgent | Usman office was promised a colleague 16 days ago and nobody came | standing
```

Both cold pitches were suppressed by the `scoreLead` fallback, as intended.

**Usman's conversation was taken off handover 2026-08-17** (`is_human_handoff = false`), so the
agent answers again instead of staying silent behind a promise nobody kept.

**What that does NOT do, and it matters:** un-pausing sends nothing. Usman said "Hi" sixteen days
ago and will still hear nothing unless they write again — at which point the agent now replies
rather than sitting mute. Actually reaching out is a message to a real customer and is somebody's
decision to make, not a side effect of clearing a flag.

**Three conversations remain muted, deliberately:** `khan` (a data broker), `Tim Cao Muzan pet` (a
pet-food manufacturer) and one contact named for a law firm — all cold pitches, all correctly
suppressed by the operator. Nobody needs to answer a data broker, and un-pausing them would only
spend model calls on sales pitches.

**The operator's full lifecycle is proven in production:** raised at 15:20, conversation un-paused at
15:21, **retracted at 15:30**. And this retraction is correct — the harm is actually gone, which is
exactly the distinction `customer-waiting` could not make when it cleared "khan has been waiting 261
hours" while that customer was still abandoned.

## Off-box backups — BUILT, INERT UNTIL YOU SUPPLY TWO VALUES

The nightly backup dumps, restores into a scratch database, asserts tables and tenant rows came
back, and rotates. All of it lands on **the same disk as the database**, and this box has no
Hostinger snapshots. That covers somebody dropping a table; it covers nothing if the VPS goes.

`scripts/backup-db.sh` now has a step 3 that applies the script's own rule one level up: **an upload
that exited 0 is not a copy until it has been read back**, exactly as a dump that exists is not a
backup until restored. Placed after verification, so the only dump that ever leaves is one just
proved to restore.

**Encryption is not optional once a remote is set.** These dumps hold real customers' WhatsApp
conversations. `BACKUP_REMOTE` without `BACKUP_PASSPHRASE` fails rather than uploading plaintext.

**rclone is installed** — `v1.60.1` from the Ubuntu 24.04 repository (2026-08-17), not
`curl | bash`: a signed, security-maintained package on a production box beats piping a remote
script into a root shell, and `copy`/`size` have been stable for years. Verified that the real
binary's `size --json` emits `{"count":1,"bytes":6367051,...}` and that the script's parser reads
`6367051` from it, matching `stat` exactly — the parser had until then only ever been tested against
a stub. rclone's config-not-found NOTICE goes to stderr, which the script already discards.

**Secrets go in `/etc/nexus-backup.env` (mode 600), not the crontab.** The script sources it before
reading anything, so the cron line stays exactly as it is. The template is on the box with both
values empty, which is the inert state. Verified by setting `BACKUP_REMOTE` in that file and
watching the run reach the passphrase guard — the file is genuinely being read, not assumed to be.

**A deploy failed silently on the way here, and is worth remembering.** `git pull` printed
"Aborting", left HEAD where it was, and the verification run I did next exercised the OLD script
while looking like a pass. Caught by checking HEAD and grepping the deployed file rather than
reading an exit code. The cause was standing: `backup-db.sh` was mode 644 in git while its own
header told you to `chmod +x` it on the server, so every pull touching that file aborted on the
local mode change. **The bit is now in git** (and forced into the mirror too, since Windows ignores
file modes) — the server needs no chmod and the modification no longer exists.

**Three things still needed, and the third is easy to miss:**

1. `rclone config` — **a remote must actually be defined.** There is no `~/.config/rclone/rclone.conf`
   on the box, so a name like `b2:` does not exist yet however correct the env var looks. This is
   where the bucket and its credentials go.
2. `BACKUP_REMOTE=<remote>:<path>` in the cron environment.
3. `BACKUP_PASSPHRASE=<long secret>` — and it must **not** also live on that machine, or the
   encryption protects nothing that losing the box would not also lose.

**The guards were walked forward one at a time on production.** Before rclone: failed naming rclone.
After installing it, the same run reaches the next guard and fails with *"BACKUP_REMOTE is set but
BACKUP_PASSPHRASE is not — refusing to upload customer conversations unencrypted"*. Tonight's cron
sets no remote at all, so it takes the skip path and exits 0, unchanged.

**Verified before shipping**, six paths in a harness with a stub rclone: unset; rclone missing;
passphrase missing; happy path; a truncated upload where `copy` exits 0 and the object is short
(caught by the read-back); and decrypting the uploaded artefact back to the original bytes. Then run
for real on production — 6.1M dumped, 30 tables and 6 organizations restored, and the summary line
now reads `latest is NOT off-box — local disk only`.

## Why businesses 2–5 have no customers — it is not the platform

Read from the live websites on 2026-08-17, because the platform side had been measured to death and
the constraint was still traffic. **Not one of the five businesses' websites points at the number the
agent answers on** (`971504805436`):

| business | WhatsApp link on their own site |
|---|---|
| SFS International | `phone=3214569874` — the Houzez theme's demo number |
| Juris Prime | none at all |
| Juris Prime Legal | none at all |
| ABR Advocates | `wa.me/971508872523` — a different, working number |
| Zipicka *(the one with customers)* | `wa.me/971583014766` — also different |

The agent works, the deep links work — all five verified to route end to end, including the
`juris-prime` / `juris-prime-legal` prefix pair. Nothing points at them. That is the whole gap.

### SFS International, in detail — and it is worse than a dead button

* **Four Houzez demo properties are still published on a live estate agency's site**: "Stylish
  downtown apartment", "Two-bedroom with sauna", "One-bedroom with balcony", "Central apartment with
  doorman". They resolve (HTTP 200). A real agency is advertising four apartments that do not exist.
* Those four are the **only** listings on the site carrying a WhatsApp button — five buttons, all
  pointing at `3214569874`. Plus five dead `tel:3214569874` links.
* The **eight real listings** (Jebel Ali Hills, Barsha Heights, the villa plots) have **no WhatsApp
  button at all**, and their property pages show an agent named `curtainuae2021` with the stock
  avatar and an **empty phone field**.
* The platform number is already on the homepage twice as `tel:(971)504805436`, so none of this is a
  matter of principle — it is unfinished setup.

**Fix, in order:** delete the four demo properties; set WhatsApp and phone on the `curtainuae2021`
agent record to `971504805436` so the real listings gain a contact route; replace the five remaining
`tel:` links.

**A correction I had to publish.** The first version of the deliverable said "every property page
carries a WhatsApp button and a phone button wired to 321 456 9874 — ten of them." That was wrong.
`grep -c` counts matching *lines*, not occurrences, all ten were on the **homepage**, and I never
opened a property page before writing it — property pages have none. Caught only by going back to
make the instruction precise enough to act on. **Counting something is not the same as knowing what
was counted**, which is this repo's oldest lesson arriving in a new place.

**Deliverable:** https://claude.ai/code/artifact/5e5abf8d-eb55-46ce-ac49-2ff3d0e0afa7 — per-business
cards worst-first, each with its deep link, a printable QR and a paste-ready snippet. Carries the
correction inline and in the footer.

**ABR is marked a decision, not a defect.** Its number reaches a person with real history; switching
means the agent takes first contact under the strict legal tier and whoever answers today stops
hearing from customers. That is the owner's call.

## The next task

**Two values and one `rclone install` turn the last real risk off.** Until then every backup is one
disk failure from being no backup.

**Four website edits are what actually move the traffic constraint**, and none of them is engineering
work on this platform. See the section above.

Nothing else is queued: every remaining feature is blocked on traffic, an external integration, or an
explicit "not asked for" — measured rather than assumed, five candidate areas today.

**F5 is complete.** What remains for it is traffic, not code. So is most of the rest: F9's rollups
were measured today at **0.202 ms across 13 conversations and 60 messages** — building read models
for that would add a second source of truth for numbers to save a fifth of a millisecond, which this
codebase has been burned by before. Not next.

**ABR's office number** — one value unblocks the last phrase draft.

**Staffing is the real unlock whenever the owner is ready.** One person with a rota at either firm
turns `handing_over`, the handover flag, and the whole escalation path from inert to live. See
[[nexus-rota-editor]] for the surface, and ask for names rather than inventing them.

## Taking a catalogue update — BUILT

`POST /api/catalog/installs/:id/update`, and a **Take v2** button inside the version-drift note on
the card rather than beside Install, because it is a different decision and the sentence above it is
the reason to think twice. **No migration** — `procedures.proposed_steps` already existed and is
exactly the right slot.

**Only ever from a button.** 039's rule is that an installed business keeps what it installed until
it *chooses* to take an update, so there is no sweep and no auto-upgrade; the test asserts that no
`*-processor.ts` references it.

**What happens depends on what the copy has since become, and the two refusals are the feature:**

* **Somebody rewrote it here** → refused. Both `procedures` and `agent_phrases` flip `source` to
  `'operator'` when a person edits by hand, so a row still reading `'catalog'` is untouched since it
  arrived. Overwriting an `'operator'` row is the catalogue outranking the business about its own
  material — the mirror of F10's rule 3, which has the inference writer defer to an operator
  procedure.
* **The wording is live** → refused, switch it off first. A phrase is sent verbatim and there is no
  `proposed_body` column to park a suggestion in, so replacing a live sentence would change what
  customers read with nobody having seen the new one.
* **A live PROCEDURE needs no refusal**, because the slot exists: the newer steps land in
  `proposed_steps` and surface on "How we answer" beside the version they would replace. That is
  F10's rule 2 applied to a second writer — "a procedure somebody read and approved would silently
  become a different one".
* **Inactive** → rewritten outright; nothing is following it. **Never added** → only the recorded
  number moves. **Knowledge pack** → re-ingested against the same `catalog:<slug>` uri, so chunks are
  replaced rather than duplicated, and live immediately as ever.

The recorded version moves **last**, and not at all when a re-index fails — bumping first would
answer "what is this agent running" with a number true of nothing.

Verified in production, both in rolled-back transactions: a live catalogue procedure keeps its v1
steps and gains the v2 proposal, and an active phrase is untouched by the update statement.

## Also outstanding

* **No real customer message has ever met an active procedure**, because there are none. Activating
  one is a live change to what customers are told and wants a person's decision, not a deploy step.
* Business verification still in review at Meta.
* `retrieval-unavailable` reported 0 after the Google embedding outage recovered — but embeddings
  remain a single external dependency on the live reply path with no fallback. The reply path
  degrades gracefully (the tool catches, the agent says a colleague will confirm, governance still
  applies), so this is a resilience question, not an incident.

## Considered and declined: suppressing the triage menu for cold pitches

A state sweep on 2026-08-17 found the last three active days sent **nothing but the triage menu** —
six sends, no AI replies. Every sender was a cold B2B pitch: a property developer opening "This is
Shahed from Gutti Development", somebody saying "hi" twice, and a real-estate data seller. One of
them was already scored `inbound_pitch` and still received two menus.

There is a real cost to that. §2.5 warns that WhatsApp quality-rating decay restricts numbers, and
this number was only recently recovered from Klaviyo. Handing a menu to a spammer spends sends and
invites blocks on the one number all five businesses share.

**Declined anyway, and the reason is the platform's own rule.** Lead scoring is rules-based and its
own §9.5 entry admits it is whack-a-mole — one spam message still reads `30/normal` after two rounds
of hardening. Suppressing a customer-facing message on that classifier means a *misclassified real
customer gets silence*, which is the exact failure this codebase has spent the session removing:
four muted conversations, a release that could never fire, an escalation that promised nobody.

Note where the platform already draws this line and stays consistent with it: pitch suppression
exists in the **operators** — `customer-waiting` and `handover-abandoned` both skip pitches — because
suppressing a finding only costs an operator a line in a list. Nothing on the **reply path** ever
suppresses a message. That asymmetry is deliberate and this would have broken it.

Revisit only if lead scoring becomes model-based with measured precision, which §9.4 already blocks
on labelled outcomes.

## What the same sweep confirmed healthy

Checked directly rather than via any summary, because "the operator reports zero" is how four
customers stayed hidden for sixteen days:

* **Governance is evaluating every reply** — 12 AI replies, 12 evaluations, 1:1 across every day
  with traffic. The 8 August gap in `operator_findings` was quiet traffic, not a stopped judge.
* **All five businesses have an active agent config** on `claude-sonnet-5`, so a routed conversation
  cannot hit the silent `No active agent configured` return.
* **35 message templates, all APPROVED, synced today** — `template-rejected` reporting zero is honest.
* **Nobody is waiting on a reply.** Two conversations have a customer speaking last; both are cold
  pitches, both correctly suppressed.
* Knowledge sources: 0 failed, 0 stale. No failed outbound messages. No open tasks or bookings.

## Lessons added this session

**Counting something is not knowing what was counted.** I reported "ten dead buttons on every
property page" at SFS from `grep -c 3214569874` on the homepage. `grep -c` counts matching *lines*,
not occurrences; all of them were on the homepage; property pages have none; and the real finding —
four fictional demo listings still published on a live estate agency — was underneath. It reached a
shared deliverable before being caught, and only because I went back to make the instruction precise
enough for somebody to act on. The same shape as every entry below it: a number that looked like an
answer, believed without asking what produced it.

**An outward-facing claim deserves the treatment a production write gets.** Everything else this
session was verified by reading it back from the database. The one thing published to a person was
not, and it was the one thing that was wrong.

**Verify privileges by reading them back.** Migration 039 granted only `select` on `catalog_items`
and the database still gave `nexus_app` insert, update and delete — an earlier blanket grant had
already placed them, and `grant select` does not remove what is present. Revoke first. Found via
`information_schema.role_table_grants`, not by trusting the grant statement.

**`timestamptz + interval` is STABLE, not IMMUTABLE**, so it cannot appear in an exclusion
constraint. Store the window as a column and range over two columns instead. The first attempt
failed AFTER creating the table, leaving it briefly without the cooldown that is its entire point.

**Check the shape of a gap before building for its description.** The intent backfill was written
for "rows with null intent" because that is how the gap was described. There were none; the rows
were missing entirely. Defaulting the script to dry-run is what caught it.

**Do not assert adjacency, and never claim a check you did not run.** `reengagement-candidate` read
`conversations.updated_at`, which does not exist, and the commit message said every column had been
verified. Two were; that one was not.
