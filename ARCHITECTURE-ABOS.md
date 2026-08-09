# Nexus ABOS — Architecture & Delivery Program

Evolving Nexus Agentic OS from a multi-tenant WhatsApp agent platform into an
Autonomous Business Operating System, **without rewriting the working system
underneath it.**

This is the engineering plan of record. It is deliberately opinionated about
sequencing, because the order these features land in matters more than any
individual design.

**Status: 2026-08-03.** Phases 0, 2 and 3 are shipped and verified in
production. Feature 12 is half done. Section 9 is the register of what has
*not* been done and why — read that before planning the next block of work.

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

3. **Rollup read models for the deck.** The deck still aggregates over live
   tables. Fine now, collapses at scale. Not yet built.

---

## 4. Shipped

| Phase | What landed |
|---|---|
| **0 — Survivability** | Verified backups (dump → test-restore → rotate, nightly); 5-tenant cap removed; governance fails safe for unknown tenants |
| **1 — Employee Agent Layer** | `employees`, presence engine (pure, DST-aware, overnight shifts, UTC fallback), attributed AI twin with signature backstop, employee-aware routing |
| **2 — Knowledge** | Schema + chunker + Gemini embeddings + citation-bearing retrieval; URL connector with SSRF guard; cross-page boilerplate stripping; 6-hourly re-indexing; **80 live chunks of real Zipicka content**, retrieval verified against real customer questions |
| **3 — Lead Intelligence** | Rules-based scoring with signal audit trail; direction-aware spam detection; complaints always urgent |
| **12 — Security** | API authentication (was fully open, leaking customer PII); WebSocket auth; inbox login gate; app de-privileged from Postgres superuser |
| **Switchboard** | One WhatsApp number serving all five businesses. Whole-word bilingual classifier that returns routed / ambiguous / unknown and **refuses to guess**; bounded triage menu; the routed tenant selects the agent, the knowledge scope and the governance policy. Ships inert — engages only when two or more tenants share a number |

**147 tests, typecheck clean across 10 workspaces. A live self-check (`apps/api/src/scripts/self-check.ts`) runs the real queries against the real schema — it found a data-loss bug that every unit test missed, because a mocked pool cannot see an ON CONFLICT clause.**

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
### 🟡 Continuous — Security
Auth and least-privilege done. RLS steps 3–4 outstanding.

---

## 6. Per-feature status

| # | Feature | Status |
|---|---|---|
| 1 | Employee Agent Layer | ✅ Built. Open: calendar presence, twin handback generator, employee CRUD UI |
| 2 | Knowledge Ingestion | ✅ Core + URL connector. Remaining connectors phased by real demand |
| 3 | Lead Intelligence | ✅ Rules-based, EN + AR. Model second once labels exist |
| 4 | Campaign Engine | ⛔ Not started. Highest-risk feature in the program |
| 5 | Neural Brain | ⛔ Not started. Needs PII redaction gate first |
| 6 | PAUL v2 | 🟡 `.claude/` layer installed; self-improvement loop not built |
| 7 | Workspace | ⛔ Months of work. Scope hard before starting |
| 8 | Operators | ⛔ Blocked on §2.3 |
| 9 | Command Center | 🟡 Deck exists on live queries; rollups not built |
| 10 | Memory | 🟡 Semantic layer exists; episodic/procedural not formalised |
| 11 | Predictive BI | ⛔ Blocked on data volume |
| 12 | Security | 🟡 Auth + least-privilege done; RLS outstanding |
| 13 | Marketplace | ⛔ Needs a data-egress policy first |
| 14 | Self-improving AI | ⛔ Cheap version (correction + escalation rate) not built |
| 15 | BI Copilot | ⛔ Needs rollups (F9) first |

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

Containers were green throughout. **Prefer checks that assert expected data
EXISTS over checks that confirm nothing errored.** `preflightModels()` at worker
boot exists for exactly this reason: it calls every configured model and logs a
loud error naming affected tenants, rather than waiting for a customer to
receive a fallback.

---

## 9. Deferred work — what was not done, and why

Grouped by *what unblocks it*, because the reason matters more than the item.

### 9.1 Blocked on you, not on engineering

- **Onboard tenants 2–5.** Four tenants hold placeholder `phone_number_id`s and
  physically cannot receive a message. Needs each business's real number, Meta
  Business Manager access, and a verification code sent to that handset. *This
  is the single highest-value item in the document* — every feature here is
  built for five tenants and exercised by one.
- **Operators: event-triggered or paid inference?** (§2.3) Blocks Phase 4.
- **Workspace scope.** Full Monday.com parity is years. Boards + tasks tied to
  conversations is weeks. Someone must choose.

### 9.2 Deliberately not attempted — would have been unsafe

- **RLS policies (F12 steps 3–4).** A wrong policy returns zero rows with no
  error: empty inbox, worker unable to route. Needs the fail-loud context
  assertion and a cross-tenant bypass role first (§2.2).
- **Campaign engine (F4).** Rushed, it costs the WhatsApp number (§2.5).

### 9.3 Genuinely large

- **Workspace (F7)** — months.
- **Remaining knowledge connectors** — Shopify, Drive, PDFs, OCR, audio. Each is
  an isolated fetch-and-parse problem now that the pipeline exists; add on real
  demand rather than building thirty at once.
- **Rollup read models (F9)** — prerequisite for the Command Center and F15.

### 9.4 Blocked on data, not code

- **Predictive BI (F11)** — one live tenant makes this numerology.
- **Model-based lead scoring** — needs labelled won/lost outcomes. The current
  rules are generating exactly that history.
- **Self-improving AI (F14)** — needs a ground-truth set. The cheap version
  (track correction rate + escalation rate) is buildable now and is not.

### 9.5 Known limitations in shipped features

- ~~**Lead scoring is English-only.**~~ **Fixed 2026-08-03.** Now bilingual
  English + Arabic, compared after orthographic normalisation (diacritics,
  alef/yaa/taa-marbuta variants, Arabic-Indic digits) so real spelling variation
  matches. Languages beyond those still score 0 and floor at `low` — a
  deliberate floor, not a failure: the lead reaches the inbox, just unranked.
- **Rules are whack-a-mole against adversarial senders.** One spam message still
  reads 30/normal after two rounds of hardening. This is the argument for
  *rules first, model second*, not for more rules.
- ~~**Knowledge is operable only by script.**~~ **API added 2026-08-03** —
  `GET/POST/DELETE /api/organizations/:slug/knowledge`, authenticated and
  tenant-scoped, returning source health rather than bare titles. **Still no
  UI**, so it remains a curl-level tool rather than something a non-technical
  owner can use.
- **Employee layer is dormant.** Zero employees exist, so presence, twins and
  handbacks are live but unexercised.
- **No OpenTelemetry.** Phase 0 called for traces and structured alerting; only
  structured logging exists.

---

*Maintained alongside `Nexus-Brain/` (project knowledge) and `.paul/` (delivery loop).*
