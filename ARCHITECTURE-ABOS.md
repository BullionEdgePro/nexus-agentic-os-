# Nexus ABOS — Architecture & Delivery Program

Evolving Nexus Agentic OS from a multi-tenant WhatsApp agent platform into an
Autonomous Business Operating System, **without rewriting the working system
underneath it.**

This document is the engineering plan of record. It is deliberately opinionated
about sequencing, because the order these features land in matters more than any
individual design.

---

## 1. Honest baseline (2026-08-01)

What is actually true today, because the plan has to start from here:

| Reality | Consequence for this program |
|---|---|
| 1 of 5 tenants has a live WhatsApp number | ABOS features built for "all tenants" have one real user |
| The Gemini switch has **not yet been confirmed against a live inbound message** | The reply path is unproven since the provider change |
| Postgres has **no automated backup** | Every table this program adds is also unbacked |
| Single VPS: 2 vCPU / 4 GB, all services co-resident | Several features below do not fit on this box |
| `organizations.slug` is a `CHECK` constraint over 5 literal values | **Tenant #6 fails to insert.** Hard blocker for any scale story |
| AI inference is on Gemini's **free tier** | Free tier is a rate-limited hobby budget, not an autonomous-operator budget |

None of these make the vision wrong. They change what "Phase 1" means.

---

## 2. Five constraints that reshape the plan

These are the findings a design review has to surface before writing code, not after.

### 2.1 The tenant ceiling is a `CHECK` constraint
`schema.sql` pins `organizations.slug` to five hardcoded values. "Scale to
10,000+ businesses" is blocked at the DDL level on line 12. Removing it is a
one-line migration and must happen before any onboarding work.

### 2.2 Tenant isolation is currently by convention
Every query manually passes `organization_id`. That works at 5 tenants and
becomes a data-breach vector at 10,000 — one forgotten `WHERE` clause leaks
across tenants. The structural fix is **Postgres Row-Level Security**, so
isolation is enforced by the database rather than by reviewer diligence. This
should land before the tenant count grows, not after.

### 2.3 Autonomous operators contradict the free tier
Feature 8 specifies 11 always-on operators that "collaborate autonomously",
plus continuous re-indexing (F2), predictive scoring (F11), and self-evaluation
(F14). Continuous multi-agent inference is fundamentally incompatible with a
free-tier rate limit. Two honest options:

- **Event-triggered operators** (recommended): operators wake on domain events,
  not on a loop. 10–100× cheaper, and no worse for the user.
- **Paid inference**: budget for it explicitly as a per-tenant cost line.

Continuous autonomous loops on free-tier keys will simply fail under load, and
the failure mode is customer-visible.

### 2.4 The AI Twin, as specified, is a legal exposure
The spec has the twin serving customers **as** a named employee, learning their
writing style, carrying their **digital signature**, with no disclosure. For the
law-firm tenant that is not a nuance — it is a customer forming a professional
relationship with a machine wearing a named lawyer's identity.

Both the EU AI Act's transparency duty and US state bot-disclosure statutes point
the same direction, and the platform's own governance code already treats
`juris-prime-legal` as a stricter tenant.

**Resolution (implemented, see §4):** the twin acts *for* the employee, never
*as* them — attributed, disclosed on request, and structurally barred from
reproducing a digital signature. This preserves essentially all product value
(fast, on-brand, personally-routed answers) and removes the entire
misrepresentation risk class.

### 2.5 The campaign engine can get the WhatsApp number banned
Feature 4 says "replace simple bulk messaging". WhatsApp Business is not an
email list: templates need pre-approval, free-form replies are confined to the
24-hour service window, opt-in is mandatory, and quality rating decay gets
numbers restricted. This number was only just recovered from Klaviyo — losing it
to a policy strike would undo the most expensive work done on this project.

The campaign engine must therefore be **Meta-policy-native**: template registry
with approval state, opt-out ledger enforced at send time, per-number rate
governor, and quality-rating monitoring that can halt a campaign mid-flight.

---

## 3. Target architecture

Preserving the existing shape — Hono API, BullMQ workers, Postgres, Next.js —
and adding structure rather than replacing it.

```
                    ┌──────────────────────────────────────────┐
   WhatsApp ───────▶│  apps/api   webhook · REST · WS          │
   (+ future        └───────────────┬──────────────────────────┘
    channels)                       │  domain events
                    ┌───────────────▼──────────────────────────┐
                    │  Event bus (Redis Streams)               │
                    │  message.received · lead.scored ·        │
                    │  presence.changed · knowledge.updated    │
                    └───┬───────────┬───────────┬──────────────┘
                        │           │           │
              ┌─────────▼──┐ ┌──────▼─────┐ ┌───▼───────────┐
              │ reply      │ │ operators  │ │ ingestion     │
              │ worker     │ │ (event-    │ │ worker        │
              │ (exists)   │ │  triggered)│ │ (F2)          │
              └─────────┬──┘ └──────┬─────┘ └───┬───────────┘
                        │           │           │
                    ┌───▼───────────▼───────────▼──────────────┐
                    │  Postgres  (+ pgvector)  ·  RLS-isolated │
                    │  write model  →  rollup read models      │
                    └──────────────────────────────────────────┘
```

**Three decisions worth stating explicitly:**

1. **Redis Streams, not Kafka.** Redis is already in the stack and already
   carries `publishInboxEvent`. Formalising a typed domain-event envelope over
   it delivers the event-driven requirement with zero new infrastructure. Kafka
   is a Phase-4+ conversation, if ever.

2. **pgvector, not a separate vector database.** Embeddings live in the
   Postgres already deployed. One fewer service on a 4 GB box, and RAG joins
   stay in-database next to the tenant filter — which is also how the tenant
   isolation story stays intact for embeddings.

3. **Rollup read models for the deck.** The command deck currently aggregates
   over live `messages` / `conversation_metrics`. That is fine at today's
   volume and collapses at scale. Analytics reads move to incrementally-updated
   rollup tables (the pragmatic 80% of CQRS, without splitting the datastore).

---

## 4. Phase 1 — Employee Agent Layer ✅ *implemented this session*

Feature 1, built and merged. The conversation hierarchy is now
`Tenant → Employee → Conversation`.

**Schema** (`packages/db/migrations/001-employee-agent-layer.sql`) — idempotent
and additive: `employees`, `employee_presence_events`, `twin_handbacks`, plus
nullable `conversations.employee_id` / `messages.employee_id`. Every existing
row keeps `employee_id = NULL`, which resolves to precisely today's org-level
behaviour, so the migration is a no-op for live traffic until an employee is
actually created.

**Presence engine** (`packages/employees/src/presence.ts`) — pure and
synchronous, so per-tenant scheduling policy is unit-testable with no database
and adds no latency to the reply path. Resolution precedence: inactive → manual
override → working-hours schedule. Handles overnight shifts, scheduled breaks,
DST via the platform tz database, and degrades to UTC rather than throwing on a
malformed timezone.

**The anti-silence default.** `shouldTwinRespond` is biased toward answering.
The only case where the twin stands down for an available human is the
per-employee `human_first` flag, which **defaults to false**. Enabling the
employee layer therefore cannot introduce customer-facing silence — the failure
mode this codebase already works hardest to prevent.

**Twin identity guardrails** (`packages/employees/src/twin.ts`) — the tenant's
governance-bearing prompt stays authoritative and the employee persona layers on
top; a persona can never loosen a tenant rule. `digital_signature` is never read
into a prompt, and `containsDigitalSignature()` is a deterministic pre-send
backstop wired into the processor's escalation decision, because a prompt is
guidance and not a guarantee.

**Coverage:** 18 tests green (was 7), full monorepo typecheck clean.

**Still open in Feature 1:** calendar integration for presence, twin handback
summarisation (table exists, generator not built), employee CRUD API + UI.

---

## 5. Phase sequencing

Ordered by what unblocks what — not by feature number.

### Phase 0 — Survivability *(do before anything else)*
Not glamorous, and everything else is worthless without it.
- Automated `pg_dump` + **restore verification** (an unverified backup is a guess)
- Confirm a real Gemini reply end-to-end on live traffic
- Drop the `organizations.slug` CHECK constraint
- OpenTelemetry traces + structured error alerting

### Phase 2 — Knowledge & Memory *(F2, F10, F5)*
The substrate every intelligent feature reads from.
- pgvector; `knowledge_sources` / `knowledge_chunks` with version + freshness
- Ingestion worker: fetch → parse → OCR → chunk → embed → index, per source type
- Citation-bearing retrieval — a claim without a source is a hallucination waiting to happen
- Layered memory maps onto existing structures: working = conversation history,
  semantic = pgvector, episodic = metrics + summaries, procedural = SOPs
- Neural Brain (F5) writes markdown into the existing `Nexus-Brain` vault.
  **Privacy gate:** customer conversations become files on a laptop — redact PII
  on the way in, and keep customer-derived notes opt-in per tenant.

### Phase 3 — Revenue surface *(F3, F4)*
- Lead intelligence: intent + score written on the existing metrics path,
  starting rules-based, upgrading to model-scored once labelled data exists
- Campaign engine per §2.5 — Meta-policy-native from the first commit

### Phase 4 — Workspace & Operators *(F7, F8, F9)*
The largest build. Feature 7 alone (boards, gantt, automations, time tracking,
OKRs) is a product in its own right — scope it to what the five tenants actually
need before building Monday.com.
- Operators are **event-triggered**, each owning a bounded domain + tool set
- Command Center consumes the Phase-2 rollups; no new aggregation paths

### Phase 5 — Intelligence *(F11, F14, F15)*
Only meaningful once Phases 2–4 have produced data worth reasoning over.
Predictive BI on ~1 live tenant would be numerology.

### Continuous — Security *(F12)*
Not a phase. RLS lands in Phase 0/2, audit logging accompanies every table,
MFA arrives with multi-operator accounts.

---

## 6. Per-feature notes

Where a feature's design differs meaningfully from its spec.

| # | Feature | Key design decision |
|---|---|---|
| 1 | Employee Agent Layer | ✅ Built. Attributed twin, not impersonation |
| 2 | Knowledge Ingestion | pgvector; 30+ connectors phased by actual tenant demand, not the full list at once |
| 3 | Lead Intelligence | Rules first, model second — needs labels that don't exist yet |
| 4 | Campaign Engine | Meta-policy-native; opt-out enforced at send, not at compose |
| 5 | Neural Brain | Writes to existing vault; PII redaction gate |
| 6 | PAUL v2 | Prompt/command layer in `.claude/` — no infra, low risk, ship anytime |
| 7 | Workspace | Scope to real tenant need; full Monday.com parity is years |
| 8 | Operators | Event-triggered, not always-on (see §2.3) |
| 9 | Command Center | Reads rollups only |
| 10 | Memory | Mostly composition over existing structures + pgvector |
| 11 | Predictive BI | Blocked on data volume, not on engineering |
| 12 | Security | RLS is the load-bearing piece |
| 13 | Marketplace | Cross-tenant sharing needs an explicit data-egress policy |
| 14 | Self-improving AI | Cheap version: track correction rate + escalation rate first |
| 15 | BI Copilot | Text-to-SQL over rollups, read-only role, tenant-scoped |

---

## 7. What is genuinely hard

Worth naming so it isn't discovered late:

- **Cost per tenant.** Twins + operators + re-indexing + predictions is a large
  inference bill that scales with tenants. It needs a per-tenant cost model
  before it needs more features.
- **Infrastructure.** Ingestion (OCR, media, crawling) will not co-exist with
  the reply path on 2 vCPU / 4 GB. Workers separate from the API box, or this
  degrades customer replies — the one thing that must never degrade.
- **Feature 7 is a product, not a feature.**
- **Evaluation.** "Self-improving" requires a ground-truth set. Without labelled
  outcomes, F14 measures its own confidence, which is worse than measuring
  nothing.

---

*Maintained alongside `Nexus-Brain/` (project knowledge) and `.paul/` (delivery loop).*
