# Nexus ABOS — Architecture & Delivery Program

Evolving Nexus Agentic OS from a multi-tenant WhatsApp agent platform into an
Autonomous Business Operating System, **without rewriting the working system
underneath it.**

This is the engineering plan of record. It is deliberately opinionated about
sequencing, because the order these features land in matters more than any
individual design.

**Status: 2026-08-11.** Phases 0, 2 and 3 shipped and verified. Feature 12 is
**complete** — RLS is applied and verified *enforcing*: from ABR's tenant
context, Zipicka's ten contacts are invisible, while Zipicka still reads its
own ten. Tenant isolation is structural rather than by convention for the
first time.

Every business now has a published deep link that skips triage, which is the
first thing that makes tenant #2 acquiring customers plausible without an ad
budget.

Section 9 is the register of what has *not* been done and why — read that
before planning the next block of work. Section 8's last three rows are the
most important thing in this document: source-text tests cannot see what the
database decides, and three scripts exist because of it.

---

## 1. Baseline — what is actually true

Revised from the original 2026-08-01 baseline, which is now wrong in most rows.

| Reality | Status |
|---|---|
| 1 of 5 tenants has a live WhatsApp number | **Still true.** The central constraint on everything below |
| Gemini reply path unconfirmed | **Resolved.** Real inbound conversation handled end to end, genuine AI replies, token spend recorded |
| No automated backup | **Was wrong.** Backups existed (nightly since 2026-07-29); the real gap was that nothing *verified* them. Now dumps, test-restores and rotates |
| `organizations.slug` CHECK caps at 5 tenants | **Resolved** (migration 002). Tenant #6 can now be inserted |
| App connects as Postgres superuser | **Resolved** (migration 006). Runs as least-privilege `nexus_app` |
| Public API unauthenticated | **Resolved.** Was returning customer phone numbers to anonymous requests |
| Single VPS, 2 vCPU / 4 GB, all services co-resident | **Still true.** Several features below do not fit on this box |
| AI inference on Gemini free tier | **Still true.** Already hit a 429 on a single test model |

---

## 2. Constraints that reshape the plan

### 2.1 ~~The tenant ceiling is a CHECK constraint~~ — resolved
Dropped in migration 002. The paired code fix matters more than the DDL: the
governance policy keyed off a *denylist* of strict tenants, so a newly onboarded
tenant would have matched neither entry and fallen through to the most permissive
branch — at exactly the moment its risk profile is least understood. Inverted to
an allowlist of the tolerant, so an unrecognised tenant is now held to the
stricter bar by default.

### 2.2 Tenant isolation is by convention — half addressed
Every query manually passes `organization_id`. That works at 5 tenants and
becomes a data-breach vector at 10,000: one forgotten `WHERE` leaks across
tenants. The structural fix is Postgres Row-Level Security.

**The prerequisite the original plan missed.** The app connected as `nexus`, a
**superuser** owning every table. Superusers bypass RLS unconditionally —
`FORCE ROW LEVEL SECURITY` included — so any policy shipped then would have
looked protective and enforced nothing.

Corrected sequence, each step independently verifiable:

1. ~~Create a least-privilege app role~~ **done** (migration 006)
2. ~~Cut `DATABASE_URL` over and verify~~ **done.** Failures here are loud
   (`permission denied`), rollback is one env var
3. **Tenant-context plumbing** — `SET LOCAL app.current_org` per tenant-scoped
   request, plus an application assertion that fails **loudly** on a missing
   context rather than quietly returning nothing
4. **Enable RLS + policies**, table by table, verifying row counts after each

Step 4 is the dangerous one: a wrong policy returns zero rows with no error. It
must never ship without the step-3 assertion in front of it.

**A design mismatch to resolve first.** Classic RLS assumes one tenant per
request. Here the operator is *deliberately* a super-user across all five
tenants — the inbox shows every business — and the worker must resolve
`phone_number_id → organization` before it knows the tenant at all. Both are
legitimate cross-tenant paths needing an explicit bypass role, or step 4 breaks
message routing. RLS's value in this system is protecting against a forgotten
`WHERE` in application code, not against a hostile tenant user, because
per-tenant logins do not exist yet.

### 2.3 Autonomous operators contradict the free tier
Feature 8 specifies 11 always-on operators that "collaborate autonomously", plus
continuous re-indexing, predictive scoring and self-evaluation. Continuous
multi-agent inference is incompatible with a rate-limited free tier — and this
is no longer theoretical: `gemini-2.0-flash` returned 429 during a single
afternoon of testing.

- **Event-triggered operators** (recommended): wake on domain events, not a
  loop. 10–100× cheaper, no worse for the user
- **Paid inference**: budget it explicitly as a per-tenant cost line

**This decision is still open and blocks Phase 4.**

### 2.4 The AI Twin as specified is a legal exposure — resolved in design
The spec had the twin serving customers **as** a named employee, in their voice,
carrying their **digital signature**, undisclosed. For the law-firm tenant that
is a customer forming a professional relationship with a machine wearing a named
lawyer's identity.

**Implemented resolution:** the twin acts *for* an employee, never *as* them.
`digital_signature` is never read into a prompt, and `containsDigitalSignature()`
is a deterministic pre-send check wired into the escalation decision — because a
prompt is guidance, not a guarantee.

### 2.5 The campaign engine can get the WhatsApp number banned
WhatsApp Business is not an email list: templates need pre-approval, free-form
replies are confined to the 24-hour window, opt-in is mandatory, and quality-
rating decay restricts numbers. This number was only just recovered from Klaviyo.

The engine must be **Meta-policy-native from the first commit**: template
registry with approval state, opt-out ledger enforced *at send*, per-number rate
governor, and quality-rating monitoring that can halt a campaign mid-flight.

---

## 3. Target architecture

Preserving the existing shape — Hono API, BullMQ workers, Postgres, Next.js —
and adding structure rather than replacing it.

```
                    ┌──────────────────────────────────────────┐
   WhatsApp ───────▶│  apps/api   webhook · REST · WS          │
   (+ future        │  requireAuth on /api/* ✅                │
    channels)       └───────────────┬──────────────────────────┘
                                    │  domain events
                    ┌───────────────▼──────────────────────────┐
                    │  Redis (pub/sub today, Streams later)    │
                    └───┬───────────┬───────────┬──────────────┘
                        │           │           │
              ┌─────────▼──┐ ┌──────▼─────┐ ┌───▼───────────┐
              │ reply      │ │ operators  │ │ knowledge     │
              │ worker ✅  │ │ (not built)│ │ re-index ✅   │
              └─────────┬──┘ └──────┬─────┘ └───┬───────────┘
                        │           │           │
                    ┌───▼───────────▼───────────▼──────────────┐
                    │  Postgres · least-privilege role ✅      │
                    │  embeddings as normalized real[]          │
                    │  RLS: not yet (see §2.2)                  │
                    └──────────────────────────────────────────┘
```

**Decisions worth stating:**

1. **Redis, not Kafka.** Already in the stack and already carries
   `publishInboxEvent`. A typed domain-event envelope over it delivers the
   event-driven requirement with zero new infrastructure.

2. **No pgvector — deliberately, and contrary to the original plan.** Production
   runs stock `postgres:16-alpine`, which has no vector extension, and swapping
   the image of a live database buys nothing at this volume. Embeddings are
   stored **L2-normalized**, which makes cosine similarity exactly a dot product
   (`nexus_dot`, migration 003); a sequential scan over a few thousand chunks is
   single-digit milliseconds. The retrieval contract is written so pgvector is a
   later internal swap. **Revisit past ~10k chunks per tenant or p95 > 100ms.**

3. **Rollup read models for the deck.** The first one exists —
   `agent_quality_daily`, migration 019 — and establishes the pattern: daily
   grain per business, recomputed over a trailing window rather than
   accumulated, bounded in the tenant's own timezone. The deck overview still
   aggregates over live tables and should follow the same shape.

---

## 4. Shipped

| Phase | What landed |
|---|---|
| **0 — Survivability** | Verified backups (dump → test-restore → rotate, nightly); 5-tenant cap removed; governance fails safe for unknown tenants |
| **1 — Employee Agent Layer** | `employees`, presence engine (pure, DST-aware, overnight shifts, UTC fallback), attributed AI twin with signature backstop, employee-aware routing |
| **2 — Knowledge** | Schema + chunker + Gemini embeddings + citation-bearing retrieval; URL connector with SSRF guard; cross-page boilerplate stripping; 6-hourly re-indexing; **328 live chunks across all five businesses**, retrieval verified against real customer questions |
| **3 — Lead Intelligence** | Rules-based scoring with signal audit trail; direction-aware spam detection; complaints always urgent |
| **12 — Security** | API authentication (was fully open, leaking customer PII); WebSocket auth; inbox login gate; app de-privileged from Postgres superuser |
| **7 — Follow-ups** | The buildable half of the workspace: a promise made in a conversation, owned by a named person, with a date, raisable from the inbox and travelling back to the customer — it reaches the agent's context and the handover brief when that person messages again. No boards |
| **8 — Operators** | Four checks sweeping every business every 10 minutes, calling no model: customer waiting, overdue follow-up, unowned follow-up, failing knowledge source. Findings can be **retracted** — each pass computes the whole truth and reconciles, so the list shrinks as well as grows |
| **One console** | Everything above reachable from `nexusagenticos.com` behind one session: shared rail, role-filtered navigation, search across contacts and follow-ups, a to-do panel and an activity panel that are deliberately different lists, and per-account profiles. Two sites became one |
| **Switchboard** | One WhatsApp number serving all five businesses. Whole-word bilingual classifier that returns routed / ambiguous / unknown and **refuses to guess**; bounded triage menu; the routed tenant selects the agent, the knowledge scope and the governance policy. Ships inert — engages only when two or more tenants share a number |

**472 tests, typecheck clean across 10 workspaces. A live self-check (`apps/api/src/scripts/self-check.ts`) runs the real queries against the real schema — it found a data-loss bug that every unit test missed, because a mocked pool cannot see an ON CONFLICT clause.**

That count is the least interesting number here. Most of those tests read source
text, and §8 is a list of defects that shipped with them all green. The four
scripts in the second table of §8 are what the confidence actually rests on, and
they are the only checks that have ever found something in production.

The switchboard is where the multi-tenant claim is actually tested. Routing is
not a label on a conversation — it selects which policy approves the reply.
`juris-prime-legal` escalates at medium hallucination risk and `zipicka` does
not, so a misroute is not a cosmetic ranking error; it is a legal question
answered under retail thresholds. That is why classification runs *before* the
agent is loaded, why an ambiguous message asks instead of picking the stronger
match, and why a bare "2" only counts as a menu selection once a menu has
demonstrably been sent.

---

## 5. Phase sequencing

### ✅ Phase 0 — Survivability
### ✅ Phase 2 — Knowledge
Remaining: connectors beyond URL (Shopify, Drive, PDFs, OCR); Neural Brain (F5);
layered memory (F10) formalisation.
### 🟡 Phase 3 — Revenue surface
Lead intelligence done. **Campaign engine (F4) not started** — see §2.5.
### ⛔ Phase 4 — Workspace & Operators
Blocked on the §2.3 decision. F7 is a product, not a feature.
### ⛔ Phase 5 — Intelligence
Blocked on data volume, not engineering.
### ✅ Continuous — Security
Auth and least-privilege done. Step 3 — tenant-context plumbing — is deployed:
context flows through AsyncLocalStorage, so the fifty-odd existing queries
became tenant-scoped without being rewritten, and a new one cannot forget to
opt in. The assertion runs in `warn` mode.

Step 4 (migration 018) is **applied and verified enforcing**. `rls-verify.ts`
checks the app role is not a superuser, owner or bypass-holder *before* testing
any policy — any of those three makes the rest theatre — then proves one
business cannot read another's rows while still reading its own. It runs green
against production. The gate was evidence, not engineering, and that evidence
came from a command rather than a wait.

`apps/api/src/scripts/rls-preflight.ts` runs every read path twice under strict
mode: wrapped as the application calls them (nothing may fire) and deliberately
bare (every tenant-scoped path must refuse). The second half is the one worth
having: a preflight that only proves "wrapped calls are silent" passes just as
happily when the assertion is switched off.

Soaking real traffic would have taken weeks here and still missed the paths the
four quiet businesses never exercise. Run the preflight; if it passes, 018 is
safe to apply.

Two cross-tenant paths remain, both named in code rather than implied: the
operator console, which is meant to span all five businesses, and the boot
preflight, which asks whether every configured model still exists. The inbound
message pipeline is no longer among them — it resolves its tenant from the
phone number and narrows immediately.

---

## 6. Per-feature status

| # | Feature | Status |
|---|---|---|
| 1 | Employee Agent Layer | ✅ Built, incl. roster UI and the handover brief. Open: calendar presence (needs a calendar integration) |
| 2 | Knowledge Ingestion | ✅ Core, URL connector, scheduled re-index, and a management screen. Remaining connectors phased by real demand |
| 3 | Lead Intelligence | ✅ Rules-based, EN + AR. Model second once labels exist |
| 4 | Campaign Engine | 🟡 Built, deployed, and the **database path verified end to end** by `schema-check.ts` — draft, audience, recipients, status. Two bugs it found first: a non-existent column in the audience count, and a parameter Postgres could not type, which meant a draft could never be created. The Meta path (approved template + billing) is untested and blocked on you |
| 5 | Neural Brain | 🟡 The gate it was blocked on is built: redaction fails closed, and what may cross a tenant boundary is an allow-list of structured fields — never prose. The shared store itself is not built |
| 6 | PAUL v2 | 🟡 `.claude/` layer installed; self-improvement loop not built |
| 7 | Workspace | 🟡 The scoped slice is built: follow-ups tied to a conversation, owned, dated, raisable from the inbox — and they now travel back to the customer, reaching both the agent's context and the handover brief when that person messages again. Boards, views and automations are the months, and none is asked for yet |
| 8 | Operators | 🟡 **Built, and §2.3 answered by construction rather than by decision.** Four operators sweep every business every 10 minutes and call no model at all — customer waiting for a reply, overdue follow-up, unowned follow-up, failing knowledge source. The design property that matters is that a finding can be **retracted**: each pass computes the complete truth and reconciles, so the list shrinks as well as grows. Paid inference remains an open choice, now additive rather than blocking |
| 9 | Command Center | 🟡 Deck on live queries, plus team activity and agent quality. One rollup table exists (daily quality); the overview still aggregates live |
| 10 | Memory | 🟡 Semantic + episodic (per-business contact memory, expiring, forgettable). Procedural not formalised |
| 11 | Predictive BI | ⛔ Blocked on data volume |
| 12 | Security | ✅ **Complete.** Auth, least-privilege, tenant context, and RLS applied and *verified enforcing* — `nexus_app` is not a superuser, holds no bypass, owns no tables, and one business cannot read another's rows while still reading its own |
| 13 | Marketplace | ⛔ Needs a data-egress policy first |
| 14 | Self-improving AI | 🟡 Escalation, containment and correction rate from human actions, plus escalation hotspots pointing at the knowledge screen. Automatic action is deliberately not taken — the judgement of whether a rate is wrong belongs to someone who knows the business |
| 15 | BI Copilot | 🟡 Built on the quality rollups. Six reviewed queries; the model routes, never writes SQL. Adding a capability means adding a query on purpose |

---

## 7. What is genuinely hard

- **Cost per tenant.** Twins + operators + re-indexing + predictions is an
  inference bill scaling with tenants. Needs a cost model before more features.
- **Infrastructure.** OCR, media and crawling will not co-exist with the reply
  path on 2 vCPU / 4 GB. Workers must move off the API box, or customer replies
  — the one thing that must never degrade — degrade.
- **Feature 7 is a product, not a feature.**
- **Evaluation.** "Self-improving" needs ground truth. Without labelled
  outcomes, F14 measures its own confidence, which is worse than measuring
  nothing.

---

## 8. The failure pattern this system produces

Every serious defect found in this codebase has presented as a **plausible
normal state, never as an error**:

| Defect | How it looked |
|---|---|
| Anthropic credits exhausted | Polite "looping in a specialist" reply |
| BullMQ `:` in a job id | Webhook 200s, messages silently vanish |
| Retired Gemini model | Same polite fallback reply |
| Single-origin CORS | Empty "No conversations yet" on the bare domain |
| Unauthenticated API | HTTP 200 |
| `search_knowledge` in no tenant's tool list | Feature deployed, never invoked |
| Source identified by title | Silent duplicate on re-crawl, both copies cited |
| App as Postgres superuser | RLS would deploy and enforce nothing |
| Substring keyword matching | "video **product**ion" routes to the retail store |
| `rows[0]` of an unordered owner query | Correct today; the conversation owner drifts the day a number is shared |
| UNIQUE on the shared phone number | Schema looked right; sharing was impossible until the migration ran against prod |
| `cursor: none` with no replacement drawn | Page renders perfectly; the mouse pointer is simply gone |
| A correction applied everywhere a human reads | The agent, reading its own prompt, kept the wrong belief and answered fluently |
| Upsert assigning every column from excluded | Save reports success; the fields the form omitted are gone |
| A column name that does not exist (`whatsapp_number`) | Route 401s unauthenticated, so every external check reported the page healthy. It raised only for signed-in users, which nobody was |
| A source edit whose anchor indentation did not match | The state landed, the markup did not. Build green, tests green, feature renders nothing |
| A test suite that reads source text | Cannot know whether a column exists, a query parses, or a schema agrees. Passes with total confidence while the query is broken |
| A data-modifying CTE re-read in the same statement | The `insert` half throws and is caught immediately. The `update` half matches the row, returns its **pre-update** values, and reports a task still open that the database has just closed. Nothing errors |
| `order by <non-unique> limit 1` | An agent's reply can land on the same microsecond as the message it answers. `order by created_at desc limit 1` then picks between them by coin flip — and the customer-waiting operator's first production run reported a customer as ignored while the reply sat in the database beside their message. The second instance of this pattern in the table, written by someone who had already read the first |
| Cleanup keyed on a variable a failure prevents from setting | `schema-check` deleted its probe `where id = $1` using an id assigned from a return value. The one run where `createTask` threw *after its INSERT committed* left the id unset — so the cleanup did nothing, on the single run where there was something to clean. It works perfectly on every run where nothing went wrong, which is every run where it does not matter. Found days later by an operator reporting the orphan as a real overdue promise |
| A flag that only ever turns off | `is_human_handoff` pauses the agent and is cleared when a human works the conversation. With nobody on the rota that clearing never happens, so a single escalation mutes a customer permanently. Four production conversations sat in it, and the state is indistinguishable from a conversation a colleague is actively handling — which is exactly what the inbox showed |
| A count in a test standing in for a property | An assertion that `hasActiveEmployees(...).catch(() => true)` appears **exactly three times** failed the moment a fourth, correctly guarded, call site was added. It reported a regression that had not happened, and its obvious repair — bump 3 to 4 — is a habit that eventually waves through the unguarded call it exists to catch. The property is "every call site is guarded"; the number was never the point |
| A cookie jar asked to hold two scopes for one name | `res.cookies.set()` is keyed by NAME. Sign-out cleared the session twice on purpose — once scoped to `.nexusagenticos.com`, once host-only for older sessions — and the second call **replaced** the first rather than adding a header. Production sent one `Set-Cookie` with no `Domain` while the live cookie carries one, so sign-out returned 200 and cleared nothing. The belt-and-braces line added to make it *more* thorough is what broke it, and the response looked correct in every respect a status code can express |
| A redirect built from the origin the process thinks it serves | `new URL("/", req.url)` inside a route handler behind the proxy produced `303 -> https://61307059e8b2:3000/` — the container's own hostname. The status code is right, the header is present, and the browser lands nowhere. Middleware's `nextUrl` carries the public host and was fine, so the two paths disagreed while looking identical in source. A relative `Location` cannot be wrong, because the browser resolves it against what it actually asked for |
| A retirement condition enforced only by a code comment | The login route said the shared password should go "once a real admin account has been created and used". Two admins had signed in days earlier — the condition was already met. Nothing read it, so `demo1234` stayed a full cross-tenant login. The comment made the code look considered, which is worse than no comment: a reader checks whether the rule was thought about, not whether anything executes it |

Containers were green throughout. **Prefer checks that assert expected data
EXISTS over checks that confirm nothing errored.** `preflightModels()` at worker
boot exists for exactly this reason: it calls every configured model and logs a
loud error naming affected tenants, rather than waiting for a customer to
receive a fallback.

**The corollary, learned the hard way.** Most tests in this repo assert on
source text. That is the right tool for intent — "the organization must not come
from the request body" is a property of the code — and the wrong tool for
anything the database decides. Source-text tests cannot see a missing column, a
malformed query, or a policy returning nothing. Three scripts close that gap by
running the real functions against the real database:

| Script | Answers |
|---|---|
| `self-check.ts` | Do the shipped features still work end to end? |
| `rls-preflight.ts` | Does every path carry a tenant context, and is the guard actually live? |
| `schema-check.ts` | Does the SQL that has never run work — including the bulk-send path, before a customer triggers it? |
| `rls-verify.ts` | Do the policies *enforce*, or merely exist? Checks the app role is not a superuser, owner, or bypass-holder first, because any of those makes the rest theatre. |

`schema-check.ts` found two defects on its first two runs, both of which would
have surfaced only when a real user acted: `countReachableContacts` filtering on
a column that does not exist, and `createBroadcast` passing a parameter Postgres
could not type. The second meant no broadcast could ever be created — Send would
have failed at its first step for every user, and the campaign engine had been in
that state since it was written. Neither was visible to any test, because the SQL
only fails when Postgres plans it and nothing had ever asked it to.

Run all three after any change that touches a query. They found, between them,
a broken audience count, an unguarded write path, and an upsert that erased
fields — none of which any source-text test could have seen.

The follow-ups feature added the clearest case yet. Its four write functions
all used `with x as (insert/update ... returning id) select ... from tasks
where id = (select id from x)`, which cannot work: a data-modifying CTE's
effects are invisible to the rest of its own statement. Nineteen unit tests,
the typecheck and the production web build all passed. `schema-check.ts` failed
on the first run — but only on the `insert`, because that one has no prior row
to match and throws. The three `update` variants matched their pre-write row
and returned stale values with no error at all, and would have shipped a Done
button that closed the task and reported it still open. **The loud half of a
bug is what gets you to look at the quiet half.**

---

## 9. Deferred work — what was not done, and why

Grouped by *what unblocks it*, because the reason matters more than the item.

### 9.1 Blocked on you, not on engineering

- **Give a second business live traffic.** The shared-number switchboard removed
  the old blocker — all five tenants are now reachable on one number, agented,
  keyworded and templated. What has not changed is that **four of them have zero
  contacts**. *This remains the single highest-value item in the document.*
  Every feature here is built for five tenants and exercised by one, and several
  guards written since — the cross-tenant pattern threshold, per-business
  memory, the switchboard's tie-breaking — cannot be evaluated at all until a
  second business has customers.

  **Nothing on the engineering side is holding this up, and the census says so.**
  Counted in production 2026-08-12:

  | Business | Sources | Chunks | Contacts | Active staff |
  |---|---|---|---|---|
  | juris-prime-legal | 25 | 123 | 0 | 0 |
  | juris-prime | 17 | 91 | 0 | 0 |
  | zipicka | 6 | 80 | 11 | 0 |
  | sfs-international | 6 | 29 | 0 | 0 |
  | abr | 1 | 5 | 0 | 0 |

  Four businesses have an agent that knows their work and has never been asked a
  question. The one with customers has the *third* largest knowledge base. Two
  numbers in that table are worth acting on independently of traffic: **abr has
  five chunks**, because abshlaw.com is a single page and there is nothing more
  to index — a litigation practice whose agent knows five passages will be vague
  and escalate constantly, and the fix is content, not code. And **active staff
  is zero everywhere**, which is the escalation gap in §9.5 stated as a number.
- **Meta billing and business verification.** Bulk sending is built, templates
  are submitted, the engine is tested. It cannot send until WhatsApp has a
  payment method and verification completes. Neither is an engineering task.
- ~~**Operators: event-triggered or paid inference?**~~ **No longer blocking.**
  Shipped 2026-08-12 as scheduled checks that call no model, so the question is
  now "should we ADD an inference-driven operator", which can be answered any
  time without holding up the feature. The interval (10 min) is the first thing
  to revisit if one ever is: five businesses × six passes an hour × a model call
  is exactly the scaling §2.3 warned about.
- ~~**Workspace scope.**~~ **The small half is built.** "Boards + tasks tied to
  conversations is weeks" — the tasks half shipped 2026-08-12 (migration 025):
  follow-ups attached to the conversation they came from, owned by a named
  person, with a date, raisable from the inbox. No boards, no swimlanes, no
  dependencies. **The remaining choice is whether boards are wanted at all** —
  the list has been useful without them, and adding a board is a different
  product decision now that the underlying record exists.
- ~~**Retire the shared operator password.**~~ **Closed 2026-08-12, and it
  needed nothing from you.** Two admin accounts had already signed in on
  2026-08-10, so the retirement condition was satisfied before the code that
  enforces it existed. The door shut the moment that code deployed. Verified
  against production: `demo1234` now returns 401.

### 9.2 Deliberately not attempted — would have been unsafe

- ~~**RLS policies (F12 steps 3–4).**~~ **Done and enforcing.** Step 3 (tenant
  context, fail-loud assertion, named cross-tenant paths) shipped; step 4 was
  gated behind `rls-preflight.ts` rather than a traffic soak, because on one
  active tenant a soak would take weeks and still miss the paths the four quiet
  businesses never exercise. The preflight passed, 018 was applied, and
  `rls-verify.ts` confirms the policies *enforce* rather than merely exist.
- ~~**Campaign engine (F4).**~~ **Built Meta-policy-native**, as §2.5 required:
  templates mirror Meta's own approval state and cannot be asserted locally, an
  unapproved template is refused at send as well as at draft, and the audience is
  frozen when the broadcast is queued. Still gated on Meta billing, not on code.
- **Consuming shared patterns in the agent (F5).** The store exists and the
  two-tenant threshold correctly serves nothing today. Wiring a consumer to a
  permanently-empty source is how you get code nobody can tell is broken. Revisit
  when a second business contributes.
- **Deck overview on rollups (F9 remainder).** The rollup pattern exists
  (`agent_quality_daily`). Converting the overview at fourteen conversations buys
  nothing and adds a staleness failure mode. Revisit when volume justifies it.

### 9.3 Genuinely large

- **Workspace (F7)** — months for parity. The buildable slice this document
  named (tasks tied to conversations) is done; what is left is boards, views,
  automations and everything else Monday sells, and none of it has been asked
  for yet.
- **Remaining knowledge connectors** — Shopify, Drive, PDFs, OCR, audio. Each is
  an isolated fetch-and-parse problem now that the pipeline exists; add on real
  demand rather than building thirty at once.
- **Rollup read models (F9)** — prerequisite for the Command Center and F15.

### 9.4 Blocked on data, not code

- **Predictive BI (F11)** — one live tenant makes this numerology.
- **Model-based lead scoring** — needs labelled won/lost outcomes. The current
  rules are generating exactly that history.
- **Self-improving AI (F14)** — needs a ground-truth set before it can act.
  ~~The cheap version (track correction rate + escalation rate) is buildable now
  and is not.~~ **Stale — that version is built** and has been since the quality
  rollups: `rollUpQualityDay` derives corrections from `lag()` adjacency (a human
  message whose immediate predecessor was the agent) and escalation from
  conversations with both. This line contradicted §6's own row 14 for a while,
  which is its own small lesson about two places describing one fact.

### 9.5 Known limitations in shipped features

- ~~**Lead scoring is English-only.**~~ **Fixed 2026-08-03.** Now bilingual
  English + Arabic, compared after orthographic normalisation (diacritics,
  alef/yaa/taa-marbuta variants, Arabic-Indic digits) so real spelling variation
  matches. Languages beyond those still score 0 and floor at `low` — a
  deliberate floor, not a failure: the lead reaches the inbox, just unranked.
- **Rules are whack-a-mole against adversarial senders.** One spam message still
  reads 30/normal after two rounds of hardening. This is the argument for
  *rules first, model second*, not for more rules.
- ~~**Knowledge is operable only by script.**~~ **Closed.** The API landed
  2026-08-03 — `GET/POST/DELETE /api/organizations/:slug/knowledge`,
  authenticated and tenant-scoped, returning source health rather than bare
  titles — and the screen followed at `/deck/knowledge`: pick a business, add a
  page by URL or paste text, see which sources failed and why, remove one behind
  a confirmation that names what the agent will stop knowing. This line said
  "still no UI" for a while after the screen existed, which is the same
  two-places-describing-one-fact problem flagged in §9.4.
- **Employee layer is dormant.** Zero employees exist, so presence, twins and
  handbacks are live but unexercised. This now also means every follow-up
  raised is unassigned — there is nobody to assign one to.
- **Escalation promises a person who does not exist.** ~~Found 2026-08-12 by the
  `customer-waiting` operator on its first live sweep~~ — **the promise is fixed;
  the rota is not.** Both escalation paths — governance deciding to escalate, and
  the agent failing outright — used to send the customer *"I'm looping in a
  specialist from our team. They'll follow up shortly"*, set `is_human_handoff`,
  and thereby **pause the AI**. With no employees, nobody ever arrived. The
  conversation did not error, did not appear in any failure count, and looked
  identical to a healthy one; the customer was simply told help was coming and
  then never heard from anyone again.

  Both paths now ask `hasActiveEmployees()` first and send
  `FALLBACK_REPLY_NO_STAFF` instead, which promises nothing it cannot deliver,
  and the handoff flag is not set — so the AI keeps answering rather than going
  quiet behind a promise. `.catch(() => true)` on that lookup is deliberate: if
  the database cannot answer, assume staff exist, because over-promising once is
  better than silently changing what every customer is told on the strength of a
  failed query.

  **The conversations already muted were four, not one.** Counted in production
  rather than taken from this document, which had said one since 2026-08-12. All
  Zipicka, all still silenced: two cold pitches (a data seller, a pet-food
  manufacturer) and two people who said "Hi", were told a specialist would
  follow up, and had heard nothing for eleven days.

  The mechanism is a different bug from the promise, and worth separating.
  `ai_paused_until` is a person taking a conversation for a while and expires by
  itself. `is_human_handoff` is set on escalation and cleared only when a human
  works the conversation — so on an empty rota it is **a switch that only turns
  off**. One escalation mutes a customer for the life of the account, and
  `if (isHumanHandoff) return` is the entire mechanism.

  Fixed by reading the flag as the claim it makes — *a person is handling this* —
  and checking it against whether a person could be. No active staff means the
  flag is stale: the agent answers and the flag is cleared. The four release
  themselves on their next inbound message, which is the only moment a release
  matters. Clearing them with an `UPDATE` instead would have fixed four rows and
  left the rule intact, ready to bite the first time a business's only employee
  is deactivated.

  **What is still NOT fixed is the underlying fact.** There is nobody to escalate
  *to*. The agent now handles what it would have handed over, which is better
  than a dead promise and worse than a person, and every follow-up raised is
  still unassigned.
- ~~**The shared operator password is open on this deployment.**~~ **Closed
  2026-08-12.** It is now a bootstrap credential that retires itself once a
  named admin account has signed in. Until that shipped, any email plus
  `NEXUS_OPERATOR_PASSWORD` — defaulting to `demo1234`, because `.env` does not
  set it — was a full cross-tenant login into all five businesses' customer
  conversations.

  **The sharpest part of this one is how it ended.** Two admin accounts had
  already signed in on 2026-08-10. The condition the login route had described
  in a comment for weeks was *already true*; the only thing missing was code
  that read it. Deploying the enforcement closed the hole instantly, with no
  operator action at all — which means the platform had been sitting wide open
  for days in a state that had already met its own criterion for being shut.
  Verified against production: `demo1234` returns 401 with a message naming the
  fix, and `GET /auth/admin/bootstrap` reports `sharedPasswordRetired: true`.

  Should every admin ever be deactivated, the window reopens by design rather
  than stranding everyone. Re-open it deliberately, or recover, with:

  ```
  # With no arguments it reports what exists, including who has never signed in
  docker compose -f docker-compose.prod.yml exec -T worker \
    npx tsx apps/api/src/scripts/create-admin.ts

  docker compose -f docker-compose.prod.yml exec -T worker \
    npx tsx apps/api/src/scripts/create-admin.ts you@example.com "Your Name"
  ```

  The password is generated on the server and printed once. Then sign in with
  it at `/admin` — the sign-in is what closes the door, not the account.
- **No OpenTelemetry.** Phase 0 called for traces and structured alerting; only
  structured logging exists.

---

*Maintained alongside `Nexus-Brain/` (project knowledge) and `.paul/` (delivery loop).*
