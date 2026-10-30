# Bulk messaging: AI writing and adding numbers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the admin Bulk messaging page, add numbers in bulk or one at a time, write Quick messages and new approved messages with AI, and send new approved messages to WhatsApp for approval.

**Architecture:** Three new Hono routers mounted on `/api/bulk` beside `adminBulkRoute` (customers, writing, templates), reusing its `resolve`/`tokenFor`. A pure number reader on the web; a pure prompt/parse module on the API around `completeText`. New web components live in `apps/web/app/deck/bulk/`; `ClientsTab` and `QuickMessage` gain optional props only.

**Tech Stack:** Hono, Postgres via `@nexus/db`, `@anthropic-ai/sdk` 0.32.1 (through `packages/agents`), Next.js 14, node:test with tsx.

**Spec:** `docs/superpowers/specs/2026-10-30-bulk-ai-writing-and-add-numbers-design.md`

## Global Constraints

- Everything under `/api/bulk` stays behind `operatorOnly` (already mounted in `apps/api/src/index.ts`).
- Up to **2000** numbers per add; a request without `consent: true` is refused whole (400).
- The server accepts only international digits: **8 to 15 digits, not starting with 0**. Local numbers are completed on the page, never on the server.
- AI: model `process.env.NEXUS_WRITER_MODEL || "claude-opus-5-5"`, effort `low`, refusal fallback `fallbacks: "default"` with header `anthropic-beta: server-side-fallback-2026-07-01`, `max_tokens` 4000, no `temperature`.
- AI limit: **30** requests per admin per hour. Brief up to **500** characters. Quick drafts under **600** characters, approved under **1024**.
- New approved message names: `bulk_<code>_<label>`; codes `zipicka→zp`, `sfs-international→sfs`, `juris-prime→jp`, `juris-prime-legal→jpl`, `abr→abr`. Category MARKETING, Stop button `"Stop"` / `"إيقاف"`.
- Copy fixed by the spec: "These people agreed to get WhatsApp messages from {business}." · "The AI is not available right now — write the message yourself." · "There is already a message with that name — choose another." · "This number's WhatsApp connection cannot submit messages. Ask its owner to reconnect it in Connections." · "These {n} have never written to this number, so WhatsApp lets them get an approved message only."
- No migrations. Commit only when the owner says to deploy (house rule this session).

## Review Focus

1. **Arabic-Indic digits pasted** ("٠٥٠ ١٢٣ ٤٥٦٧"): read as 0501234567, not refused. Test in Task 2.
2. **Excel's scientific notation** ("9.71501E+11"): refused with a sentence saying Excel shortened it, never stored as a wrong number. Test in Task 2.
3. **The same person twice in two formats** ("+971 50 123 4567" and "050 123 4567"): the second is a duplicate. Test in Task 2.
4. **AI drafts with made-up placeholders** ("[Your Name]", "{customer}"): dropped by the parser, never put in an editor that sends literally. Test in Task 5.
5. **The AI taking too long**: the call gives up at 45 seconds and the page says the AI is not available; nothing hangs behind the proxy. Test in Task 4 (timeout option passed) and Task 6 (503 copy).

---

### Task 1: Admin-written messages keep their business

**Files:**
- Modify: `packages/shared/src/templates.ts` (beside `staffTemplateName`, and `templateOwnerSlug` / `attributeTemplate`)
- Test: `apps/api/test/an-admin-message-stays-with-its-business.test.mjs`

**Interfaces:**
- Produces: `BULK_TEMPLATE_CODE_BY_SLUG: Readonly<Record<string, string>>`; `bulkTemplateName(slug: string, label: string): string | null`; `isBulkTemplate(name: string): boolean`; `bulkTemplateLabel(name: string): string`. `templateOwnerSlug` resolves `bulk_<code>_` names; `attributeTemplate` answers `"other-business"` for a `bulk_` name whose code is unknown.

- [ ] **Step 1: Write the failing test** (imports from `@nexus/shared`)

```js
test("an admin message is named for its business", () => {
  assert.equal(bulkTemplateName("sfs-international", "Weekend viewings!"), "bulk_sfs_weekend_viewings");
  assert.equal(bulkTemplateName("juris-prime-legal", "x".repeat(80)).length <= "bulk_jpl_".length + 48, true);
  assert.equal(bulkTemplateName("review-demo", "Hi"), null);
});
test("it is offered to its own business and to nobody else", () => {
  assert.equal(attributeTemplate("bulk_sfs_weekend_viewings", "sfs-international"), "own");
  assert.equal(attributeTemplate("bulk_sfs_weekend_viewings", "zipicka"), "other-business");
  assert.equal(attributeTemplate("bulk_zz_anything", "zipicka"), "other-business");
  assert.equal(attributeTemplate("hand_made_template", "zipicka"), "unattributed");
  assert.equal(templateOwnerSlug("bulk_jp_update"), "juris-prime");
});
test("the label reads back", () => {
  assert.equal(isBulkTemplate("bulk_zp_eid_offer"), true);
  assert.equal(isBulkTemplate("staff_1a2b3c4d_offer"), false);
  assert.equal(bulkTemplateLabel("bulk_zp_eid_offer"), "eid offer");
});
```

- [ ] **Step 2: Run it and see it fail**
Run: `cd apps/api && node --import tsx --experimental-test-module-mocks --test test/an-admin-message-stays-with-its-business.test.mjs`
Expected: FAIL, `bulkTemplateName` is not exported.

- [ ] **Step 3: Implement** in `templates.ts`. The label words follow `staffTemplateName` (lowercase, NFKD, `[^a-z0-9]+` → `_`, trimmed, 48 characters, `"message"` when empty). `attributeTemplate`: `owner === null ? (isBulkTemplate(name) ? "other-business" : "unattributed") : owner === slug ? "own" : "other-business"`.

- [ ] **Step 4: Run it and see it pass**, then run the existing template tests: `node --import tsx --experimental-test-module-mocks --test test/*template*.test.mjs` (all pass).

### Task 2: The number reader (web)

**Files:**
- Create: `apps/web/lib/phone-list.ts`
- Test: `apps/web/test/adding-numbers-reads-any-list.test.mjs`

**Interfaces:**
- Produces:
  - `interface DialCountry { code: string; name: string; dial: string; lengths: number[] }`; `COUNTRIES: DialCountry[]` (AE 971 [8,9], SA 966 [9], OM 968 [8], QA 974 [8], BH 973 [8], KW 965 [8], IN 91 [10], PK 92 [10], PH 63 [10], GB 44 [10]); `UAE = COUNTRIES[0]`.
  - `readPhoneNumber(raw: string, country: DialCountry): { waId: string; corrected: boolean } | { error: string }`
  - `type PhoneOutcome = "ready" | "corrected" | "known" | "duplicate" | "refused"`
  - `interface PhoneRow { line: number; raw: string; name: string | null; waId: string | null; outcome: PhoneOutcome; note: string | null }`
  - `readPhoneList(text: string, country: DialCountry, known: Set<string>): PhoneRow[]`
  - `countOutcomes(rows: PhoneRow[]): Record<PhoneOutcome, number>`
  - `formatInternational(waId: string): string` ("971501234567" → "+971 50 123 4567"; other countries "+<dial> <rest>")

- [ ] **Step 1: Write the failing tests**

```js
const read = (raw) => readPhoneNumber(raw, UAE);
test("UAE numbers in every common form", () => {
  for (const raw of ["+971 50 123 4567", "00971501234567", "971501234567"]) assert.deepEqual(read(raw), { waId: "971501234567", corrected: false });
  for (const raw of ["050 123 4567", "0501234567", "50-123-4567", "(050) 123.4567"]) assert.deepEqual(read(raw), { waId: "971501234567", corrected: true });
});
test("Arabic-Indic digits are read as digits", () => {
  assert.deepEqual(read("٠٥٠١٢٣٤٥٦٧"), { waId: "971501234567", corrected: true });
});
test("Excel's shortened numbers are refused with a reason", () => {
  assert.match(read("9.71501E+11").error, /Excel shortened/);
});
test("too short, too long and letters are refused", () => {
  assert.ok("error" in read("12345"));
  assert.ok("error" in read("+9715012345678901"));
  assert.ok("error" in read("call me"));
});
test("a list: names, separators, duplicates, known customers", () => {
  const rows = readPhoneList("Name,Phone\nAhmed 050 123 4567\n+971 55 987 6543 Sara; 0521112222\n\n+971501234567\nnobody here", UAE, new Set(["971521112222"]));
  assert.deepEqual(rows.map((r) => [r.name, r.waId, r.outcome]), [
    ["Ahmed", "971501234567", "corrected"],
    ["Sara", "971559876543", "ready"],
    [null, "971521112222", "known"],
    [null, "971501234567", "duplicate"],
    [null, null, "refused"],
  ]);
  assert.equal(rows[0].note, "050 123 4567 → +971 50 123 4567");
  assert.deepEqual(countOutcomes(rows), { ready: 1, corrected: 1, known: 1, duplicate: 1, refused: 1 });
});
test("another country completes local numbers with its own code", () => {
  const india = COUNTRIES.find((c) => c.code === "IN");
  assert.deepEqual(readPhoneNumber("09876543210", india), { waId: "919876543210", corrected: true });
});
```

(The first line of a list with no digits is a header and is skipped; any later line with no digits is refused as "No phone number on this line.")

- [ ] **Step 2: Run and see it fail**
Run: `cd apps/web && TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test test/adding-numbers-reads-any-list.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `phone-list.ts`.** Map `٠-٩` and `۰-۹` to `0-9` first. Split each line on `[,;\t]` into segments; a segment's numbers are the runs matching `/(?:\+|00)?\d[\d\s().\-]{6,}\d/g`. Each number takes its own segment's remaining text (trimmed) as its name; when the line has exactly one number and its segment has no text, the name is the line's first segment that has text and no number ("Ahmed, 0501234567"). A number containing `E+`/`e+` is refused before digits are stripped. Outcome order: refused → duplicate (same `waId` earlier in the list) → known → corrected / ready. A line with no digits is refused with `name: null` and the note "No phone number on this line." — except the first line, which is a header and skipped.

- [ ] **Step 4: Run and see it pass.**

### Task 3: Adding numbers on the server

**Files:**
- Modify: `apps/api/src/routes/admin-bulk.ts` (export `resolve`, `tokenFor`, `type SendingNumber`)
- Create: `apps/api/src/routes/admin-bulk-customers.ts`
- Modify: `apps/api/src/index.ts` (mount after `adminBulkRoute`: `app.route("/api/bulk", adminBulkCustomersRoute);`)
- Test: `apps/api/test/adding-numbers-asks-for-consent.test.mjs`

**Interfaces:**
- Consumes: `resolve(c, phoneNumberId)`; `ensureContactForServingBusiness`, `assignContactOwnerIfUnowned`, `isWaIdOptedOut` from `@nexus/db`; `actorOf`.
- Produces: `internationalWaIdRefusal(waId: string): string | null`; `POST /api/bulk/:slug/customers` with body `{ phoneNumberId, consent, rows: [{ waId, displayName?, line? }] }` → `{ results: [{ line, waId, outcome: "added"|"already-known"|"refused", reason?, contactId? }], added, alreadyKnown, refused }`.

- [ ] **Step 1: Write the failing tests**

```js
test("only international digits get through", () => {
  assert.equal(internationalWaIdRefusal("971501234567"), null);
  for (const bad of ["0501234567", "12345", "9715012345678901", "+971501234567", "97150abc"]) assert.ok(internationalWaIdRefusal(bad));
});
test("consent is checked before a single number is written", () => {
  const route = read("apps", "api", "src", "routes", "admin-bulk-customers.ts");
  assert.ok(route.indexOf("consent !== true") < route.indexOf("ensureContactForServingBusiness("));
  assert.match(route, /rows\.length > 2000/);
  assert.match(route, /isWaIdOptedOut\(/);
  assert.match(route, /if \(number\.ownerEmployeeId\)[\s\S]{0,200}assignContactOwnerIfUnowned\(/);
  assert.match(route, /consent: true/); // in the log line
});
test("the route is mounted under the admin-only prefix", () => {
  assert.match(read("apps", "api", "src", "index.ts"), /app\.route\("\/api\/bulk", adminBulkCustomersRoute\);/);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** Rows are handled one at a time, as in `contactsRoute.post("/:slug/contacts/import")`, calling `ensureContactForServingBusiness` and `assignContactOwnerIfUnowned` the same way (no extra tenant wrapper). Opted-out → refused "Asked not to be messaged."; another person's book → outcome kept, `reason: "already in {name}'s book"`. Copy: no consent → "Tick that these people agreed to get WhatsApp messages from this business."; empty → "There were no numbers to add."; too many → "Add up to 2000 numbers at a time.". Log: `logger.info({ organization, from, by, byId, consent: true, added, alreadyKnown, refused }, "Admin added numbers for bulk messaging")`.
- [ ] **Step 4: Run and see it pass**; run `test/bulk-messaging-is-the-admins-alone.test.mjs` and `test/a-campaign-that-cannot-be-recalled.test.mjs` (still pass).

### Task 4: A model choice for one caller

**Files:**
- Modify: `packages/agents/src/anthropic-text.ts`
- Test: `apps/api/test/the-writer-asks-claude-opus.test.mjs`

**Interfaces:**
- Produces: `CompleteTextInput` gains `model?: string; effort?: "low" | "medium" | "high"; fallback?: boolean; timeoutMs?: number`. Unset → today's request exactly (other callers unchanged).

- [ ] **Step 1: Write the failing test** (source-reading, the house style for this file)

```js
const SRC = read("packages", "agents", "src", "anthropic-text.ts");
test("one caller can choose its model, effort and fallback", () => {
  assert.match(SRC, /model: input\.model \?\? TEXT_MODEL/);
  assert.match(SRC, /output_config: \{ effort: input\.effort \}/);
  assert.match(SRC, /fallbacks: "default"/);
  assert.match(SRC, /"anthropic-beta": "server-side-fallback-2026-07-01"/);
  assert.match(SRC, /timeout: input\.timeoutMs/);
  assert.doesNotMatch(SRC, /temperature/);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** Build the params object, spread `output_config` / `fallbacks` only when set, cast once (`as Anthropic.MessageCreateParamsNonStreaming`; the 0.32.1 types predate these fields); pass `{ headers, timeout }` as the second argument only when set. Text extraction stays as is (it already skips thinking blocks).
- [ ] **Step 4: Run and see it pass**; `npm run typecheck -w packages/agents` clean.

### Task 5: The message writer

**Files:**
- Create: `apps/api/src/lib/message-writer.ts`
- Modify: `packages/db/src/organization-settings.ts` (add `getBusinessVoice`)
- Test: `apps/api/test/ai-writes-drafts-not-facts.test.mjs`

**Interfaces:**
- Consumes: `completeText` (Task 4); `staffTemplateBody` from `@nexus/shared`.
- Produces:
  - `getBusinessVoice(organizationId: string): Promise<BusinessVoice | null>` where `BusinessVoice = { name: string; tagline: string | null; summary: string | null }` (select `name, tagline, summary from organizations where id = $1`)
  - `type WriterKind = "quick" | "approved"`; `interface WriterBrief { kind: WriterKind; brief: string; tone?: "friendly" | "professional"; length?: "short" | "detailed"; language?: "en" | "ar" }`
  - `type RewriteChange = "shorter" | "formal" | "arabic" | "fix"`
  - `WRITER_MODEL: string`; `writerSystemPrompt(kind, voice): string`; `draftRequest(brief: WriterBrief): string`; `rewriteRequest(kind, text, change, reason?): string`
  - `parseDrafts(text: string, kind: WriterKind): string[]` (at most 3)
  - `writeDrafts(brief, voice): Promise<string[] | null>`; `rewriteDraft(kind, text, change, voice, reason?): Promise<string | null>`
  - `takeWriterTurn(adminKey: string, now?: number): boolean` (30 per rolling hour, in-process Map, like `takeTestSend`)

- [ ] **Step 1: Write the failing tests**

```js
const voice = { name: "SFS International", tagline: "Real estate — sales, rentals & property management, UAE", summary: null };
test("the AI is told who is writing and the rules", () => {
  const quick = writerSystemPrompt("quick", voice);
  assert.match(quick, /SFS International/);
  assert.match(quick, /Real estate — sales/);
  assert.match(quick, /\{name\}/);
  assert.match(quick, /Never invent prices, dates, offers, links or phone numbers/);
  assert.match(quick, /600 characters/);
  const approved = writerSystemPrompt("approved", voice);
  assert.match(approved, /1024 characters/);
  assert.match(approved, /never start or end with \{name\}/);
  assert.match(approved, /Do not mention opting out/);
});
test("drafts are split, cleaned and capped at three", () => {
  const text = "1. Hi {name}, viewings this weekend.\n---\n**Draft 2:** \"Hello {name}, reply to book.\"\n---\n\n---\nThird one.\n---\nFourth.";
  assert.deepEqual(parseDrafts(text, "quick"), ["Hi {name}, viewings this weekend.", "Hello {name}, reply to book.", "Third one."]);
});
test("made-up placeholders never reach an editor", () => {
  assert.deepEqual(parseDrafts("Hi [Your Name], hello\n---\nDear {customer}, hi\n---\nHi {name}, hello", "quick"), ["Hi {name}, hello"]);
});
test("an approved draft WhatsApp would refuse is dropped", () => {
  assert.deepEqual(parseDrafts("{name}, viewings this weekend.\n---\nHi {name}, viewings this weekend.", "approved"), ["Hi {name}, viewings this weekend."]);
});
test("thirty an hour, then wait", () => {
  for (let i = 0; i < 30; i++) assert.equal(takeWriterTurn("a", 0), true);
  assert.equal(takeWriterTurn("a", 1000), false);
  assert.equal(takeWriterTurn("a", 3_600_001), true);
  assert.equal(takeWriterTurn("b", 1000), true);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** System prompt sentences carry the spec's rules verbatim where the test pins them; the request asks for three drafts taking different approaches (direct, warm, question-led), separated by a line holding only `---`, keeping every fact in the brief exactly as written. Parser: split on `/^\s*-{3,}\s*$/m`; strip leading `1.`, `1)`, `Draft 1:`, `**Draft 1:**`, surrounding quotes; drop empties, anything with `[` … `]` or a `{…}` other than `{name}`, quick drafts over 4096, approved drafts `staffTemplateBody` refuses. Calls use `{ model: WRITER_MODEL, effort: "low", fallback: true, maxTokens: 4000, timeoutMs: 45_000 }`.
- [ ] **Step 4: Run and see it pass.**

### Task 6: Writer routes

**Files:**
- Create: `apps/api/src/routes/admin-bulk-writing.ts`
- Modify: `apps/api/src/index.ts` (`app.route("/api/bulk", adminBulkWritingRoute);`)
- Test: `apps/api/test/ai-writes-drafts-not-facts.test.mjs` (append)

**Interfaces:**
- Consumes: Task 5 exports; `findOrganizationBySlug`, `getBusinessVoice`; `actorOf`.
- Produces: `POST /api/bulk/:slug/write` `{ kind, brief, tone?, length?, language? }` → `{ drafts: string[] }`; `POST /api/bulk/:slug/rewrite` `{ kind, text, change, reason? }` → `{ text }`.

- [ ] **Step 1: Append the failing test**

```js
test("the writer routes check the limit before calling the model, and say so when the AI is away", () => {
  const route = read("apps", "api", "src", "routes", "admin-bulk-writing.ts");
  assert.ok(route.indexOf("takeWriterTurn(") < route.indexOf("writeDrafts("));
  assert.match(route, /brief\.length > 500/);
  assert.match(route, /The AI is not available right now — write the message yourself\./);
  assert.match(route, /429/);
  assert.match(read("apps", "api", "src", "index.ts"), /app\.route\("\/api\/bulk", adminBulkWritingRoute\);/);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** Invalid `kind`/`change` → 400; empty brief/text → 400 "Say what the message is about." / "Nothing to rewrite."; limit → 429 "That is 30 AI drafts this hour — wait a little, or write it yourself."; null or empty result → 503 with the fixed copy. The limit key is the actor's id.
- [ ] **Step 4: Run and see it pass.**

### Task 7: New approved messages on the server

**Files:**
- Modify: `apps/api/src/lib/whatsapp-client.ts` (add `readTemplateReviews`)
- Create: `apps/api/src/routes/admin-bulk-templates.ts`
- Modify: `apps/api/src/routes/admin-bulk.ts` (number view adds `pending`)
- Modify: `apps/api/src/index.ts` (`app.route("/api/bulk", adminBulkTemplatesRoute);`)
- Test: `apps/api/test/an-admin-message-stays-with-its-business.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1 names; `resolve`, `tokenFor`, `SendingNumber`; `createMetaTemplate`, `staffTemplateBody`, `upsertTemplateFromMeta`, `listBroadcastTemplates`, `connectionSecret`, `syncTemplatesForOrganization`, `syncStaffAccountTemplates`.
- Produces:
  - `readTemplateReviews(wabaId: string, accessToken: string): Promise<Array<{ name: string; language: string; status: string; rejectedReason: string | null }>>` (`GET /{waba}/message_templates?fields=name,language,status,rejected_reason&limit=100`, paged like `listMetaTemplates`)
  - `explainRejection(reason: string | null): string` (`INVALID_FORMAT`, `PROMOTIONAL`, `INCORRECT_CATEGORY`, `TAG_CONTENT_MISMATCH`, `ABUSIVE_CONTENT`, `SCAM` → a sentence each; otherwise "WhatsApp gave the reason: {code}.")
  - `type PendingMessage = { id: string; name: string; label: string; language: string; status: string; reason: string | null; createdAt: string }`
  - `POST /api/bulk/:slug/number/:phoneNumberId/templates` `{ label, language, text }` → `{ name, status }`
  - `POST /api/bulk/:slug/number/:phoneNumberId/templates/refresh` → `{ pending: PendingMessage[], templates }`
  - `GET /api/bulk/:slug/number/:phoneNumberId` adds `pending: PendingMessage[]` (from the mirror, `reason: null`)

- [ ] **Step 1: Append the failing tests**

```js
test("a refusal reads as a sentence", () => {
  assert.match(explainRejection("PROMOTIONAL"), /promotional/i);
  assert.equal(explainRejection("SOMETHING_NEW"), "WhatsApp gave the reason: SOMETHING_NEW.");
});
test("a new approved message is named for the business and written with the number's own token", () => {
  const route = read("apps", "api", "src", "routes", "admin-bulk-templates.ts");
  assert.match(route, /bulkTemplateName\(organization\.slug, label\)/);
  assert.match(route, /category: "MARKETING"/);
  assert.match(route, /language === "ar" \? "إيقاف" : "Stop"/);
  assert.match(route, /This number's WhatsApp connection cannot submit messages\. Ask its owner to reconnect it in Connections\./);
  assert.match(route, /There is already a message with that name — choose another\./);
  assert.match(route, /syncStaffAccountTemplates\(/);
  assert.match(route, /syncTemplatesForOrganization\(/);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** A staff number on its own account (`ownerEmployeeId && wabaId !== organization.whatsappBusinessAccountId`) needs a stored `connectionSecret`, else 409 with the fixed copy; otherwise `tokenFor`. Name null → 422 "New approved messages are not set up for this business."; `staffTemplateBody` error → 400 with its sentence; Meta duplicate (`/already exists|duplicate/i`) → 422 fixed copy; other refusal → 422 "WhatsApp did not accept it: {reason}". Mirror with `upsertTemplateFromMeta` (status from Meta, else `PENDING`). Refresh: run the right sync, then `readTemplateReviews` for reasons; pending = own `bulk_` rows on that account that are not approved. Wrap Meta failures as 502 "WhatsApp could not be reached just now. Try Check again in a minute."
- [ ] **Step 4: Run and see it pass**; run the whole API suite: `npm test -w apps/api` (only the known `mirror.sh` layout test may fail on this PC).

### Task 8: Web client calls

**Files:**
- Modify: `apps/web/lib/api.ts` (bulk section)

**Interfaces:**
- Produces: `BulkNumberView.pending: PendingMessage[]` (same shape as Task 7, exported as `BulkPendingMessage`); `addBulkCustomers(slug, { phoneNumberId, consent: true, rows })`; `writeBulkDrafts(slug, WriterBrief)`; `rewriteBulkDraft(slug, { kind, text, change, reason? })`; `submitBulkTemplate(slug, phoneNumberId, { label, language, text })`; `refreshBulkTemplates(slug, phoneNumberId)`. Each a `request(...)` call to the Task 3/6/7 routes, typed with their responses.

- [ ] **Step 1: Add the functions and types**; `npm run typecheck -w apps/web` clean.

### Task 9: The "+ Add numbers" tab

**Files:**
- Create: `apps/web/app/deck/bulk/add-numbers.tsx`
- Modify: `apps/web/app/deck/my-campaigns/clients-tab.tsx` (optional `justAdded?: Set<string>` → a "Just added N" chip that shows only those ids)
- Modify: `apps/web/app/deck/bulk/page.tsx` (step 2 tabs **Pick customers** | **+ Add numbers**; after adding: reload the number, tick added + known ids, set `justAdded`, switch to Pick, open step 3 on Approved with the fixed "never written" note)
- Modify: `apps/web/app/deck/bulk/bulk.css`
- Test: `apps/web/test/adding-numbers-reads-any-list.test.mjs` (append a source test)

**Interfaces:**
- Consumes: Task 2 reader; `readXlsxRows`, `numberCellText` (`lib/xlsx-read.ts`), `parseCsv`, `findColumns` (`lib/csv-parse.ts`); `addBulkCustomers`.
- Produces: `AddNumbers({ business, businessName, numberId, known, onAdded }: { business: BusinessSlug; businessName: string; numberId: string; known: Set<string>; onAdded: (ids: string[]) => void })`.

- [ ] **Step 1: Append the failing source test**

```js
test("the add tab asks for consent and sends only usable rows", () => {
  const src = readFileSync(new URL("../app/deck/bulk/add-numbers.tsx", import.meta.url), "utf8");
  assert.match(src, /These people agreed to get WhatsApp messages from \{businessName\}/);
  assert.match(src, /disabled=\{[^}]*!consent/);
  assert.match(src, /outcome === "ready" \|\| row\.outcome === "corrected"/);
  assert.match(src, /readPhoneList\(/);
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement.** One panel: country select (`COUNTRIES`), a paste textarea, file input (.xlsx via `readXlsxRows` + `findColumns`, .csv via `parseCsv`, turned into "name number" lines), one-at-a-time inputs (Enter appends a line). Check list with chips and counts from `countOutcomes`, each row's note. Known = the number's customers' `waId`s. After the server answers, show its per-row results (refusals with reasons) and call `onAdded` with every `contactId`.
- [ ] **Step 4: Run web tests and see them pass**; `npm run typecheck -w apps/web` clean.

### Task 10: ✨ Write with AI

**Files:**
- Create: `apps/web/app/deck/bulk/ai-writer.tsx`
- Modify: `apps/web/app/deck/my-campaigns/quick-message.tsx` (optional `assist?: (put: (text: string) => void, current: string) => React.ReactNode`, rendered above the textarea)
- Modify: `apps/web/app/deck/bulk/page.tsx` (pass `assist` to `QuickMessage`)
- Modify: `apps/web/app/deck/bulk/bulk.css`

**Interfaces:**
- Consumes: `writeBulkDrafts`, `rewriteBulkDraft`, `previewTemplate` (`my-campaigns/my-templates`).
- Produces: `AiWriter({ business, kind, sampleName, current, onUse }: { business: BusinessSlug; kind: "quick" | "approved"; sampleName: string | null; current: string; onUse: (text: string) => void })`.

- [ ] **Step 1: Implement.** Brief (500 max, counter), chips Friendly | Professional · Short | Detailed · English | Arabic, "Write 3 drafts" ("Writing 3 drafts…" while busy), drafts as bubbles via `previewTemplate(draft, sampleName)` with character counts and **Use this**; **Shorter**, **More formal**, **Arabic version** act on `current` and call `onUse`. Errors via `readableError`.
- [ ] **Step 2: Typecheck and web tests clean**; the staff page compiles unchanged (no `assist` passed).

### Task 11: New approved messages panel

**Files:**
- Create: `apps/web/app/deck/bulk/new-approved.tsx`
- Modify: `apps/web/app/deck/bulk/page.tsx` (`ApprovedSend` renders it under the picker; on opening a number with `pending.length > 0`, call `refreshBulkTemplates` once)
- Modify: `apps/web/app/deck/bulk/bulk.css`

**Interfaces:**
- Consumes: `AiWriter` (kind `"approved"`), `submitBulkTemplate`, `refreshBulkTemplates`, `rewriteBulkDraft` (change `"fix"`).
- Produces: `NewApproved({ business, numberId, pending, sampleName, onChanged }: { business: BusinessSlug; numberId: string; pending: BulkPendingMessage[]; sampleName: string | null; onChanged: (approvedTemplateId?: string) => void })`.

- [ ] **Step 1: Implement.** Toggle "✨ Write a new approved message"; label (60 max), language from the chip; editor (1024 max) with `AiWriter` above; **Send to WhatsApp for approval**; waiting list "Waiting for WhatsApp: {label} · sent {relative}" with **Check again**; a refused one shows `reason` and **Ask AI to fix it** (puts the fixed text in the editor and suggests `{label} 2`). When a check finds one approved, `onChanged(id)` selects it in the picker.
- [ ] **Step 2: Typecheck and web tests clean.**

### Task 12: Preview, full checks, deploy

**Files:**
- Modify: `C:/CLAUDE CODE/bacora/.claude/nexus-mock/mock-api.mjs` (fake answers for the five new routes and `pending`)

- [ ] **Step 1: Preview locally** (mock API + `npm run build -w apps/web` with `NEXT_PUBLIC_API_URL=http://localhost:8080`): paste a messy list, upload a CSV, add one number, write drafts, use one, open a new approved message, see a waiting one and Check again. No console errors.
- [ ] **Step 2: Full checks:** `npm test -w apps/api`, `npm test -w apps/web`, `npm run typecheck` — all pass (except the known `mirror.sh` layout test).
- [ ] **Step 3: When the owner says deploy:** commit the spec, plan and code; push `main`; run `scripts/deploy.sh` in the hPanel console; wait for `PASS`.
- [ ] **Step 4: Live:** add the owner's own number through the tab (consent ticked), write drafts with AI once (about 3 US cents). Ask before submitting a message to WhatsApp for approval.
