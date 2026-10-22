# Staff bulk WhatsApp, ready and reliable for every staff member

**Date:** 2026-10-22 · **Status:** design approved by the owner in chat, spec awaiting review
**First customer of this work:** SFS International (5 staff, all allowed to send, none able to)

## Why

Measured on the live system on 22 Oct 2026:

- No bulk campaign has ever been sent. Only one staff member on the platform (Ralph, Zipicka) passes every check.
- The shared company number was deregistered on 6 Oct; staff send from their **own** WhatsApp Business numbers. Keshav Arora (SFS) connected his on 22 Oct and receives chats on it, but it landed on a new WhatsApp account (1598768785203832) holding **zero templates**, so he cannot send a campaign. Every staff member who connects next hits the same wall: templates only reach a new account if somebody runs `scripts/provision-templates.ts` by hand, and that script only knows the company account and the platform token.
- SFS has 0 contacts, so every SFS book is empty. The importer adds contacts to a business but never into a staff member's book (`owner_employee_id`).
- The daily-limit warning reads the company account's number, not the number the campaign actually goes out from.
- Nothing stops a campaign that is failing or damaging the number's quality; it runs to the end.

## Outcome

Any staff member allowed to send can see exactly what stands between them and a campaign, the platform clears the parts that are its job without anybody running a script, and a campaign that goes wrong stops itself and says why. Success for SFS: each SFS staffer who connects a number can send an approved SFS message to their own clients without anybody touching the server.

## Design

### 1. Templates follow the number (self-healing sync)

- Move the template definitions out of `scripts/provision-templates.ts` into one shared module, `apps/api/src/lib/campaign-templates.ts` (`CAMPAIGN_TEMPLATES`, per business slug). The script keeps working and reads from it.
- Add a general update template for SFS beside `sfs_property_update` (UTILITY, one name placeholder, names SFS International), so SFS staff have two choices like Zipicka.
- `createMetaTemplate(wabaId, spec, token?)` takes an optional token; the default stays the platform token.
- `syncStaffNumberTemplates` (already runs every 30 min) gains one step per staff account: after listing what Meta holds, submit every template in that business's `CAMPAIGN_TEMPLATES` whose name is **absent** from the account, using that number's own token (`whatsappSendTokenForNumber`). Present in any status (PENDING, APPROVED, REJECTED) counts as present, so a rejected template is never resubmitted in a loop. A submission error is logged at warn and retried next cycle; it never stops the sync for other accounts.
- Result: covers both connect paths (staff self-connect and owner registering a number from Team), backfills Keshav on the first cycle after deploy, and needs no new table.

### 2. Readiness, for the staff member and the owner

- One function, `campaignReadiness(employee, organization)` in the API, returns four checks, each `{ key, ok, detail, fix }`:
  1. **Allowed to send** (`can_broadcast`)
  2. **Your number connected** (own number, not retired)
  3. **A message approved on your number** (approved, not hidden, attributed to this business, on the sending account; when only pending ones exist the detail says "waiting for WhatsApp to approve")
  4. **Clients with WhatsApp in your book** (count of `myClientsForBroadcast`)
- `GET /api/my/campaigns` returns `readiness`; the staff Campaigns screen shows it at the top, with the fix line under any check that fails. The send button stays disabled until all four pass.
- The owner's existing **WhatsApp readiness** card in Team (`whatsapp-readiness.tsx`) gains a per-person "Campaigns: n/4" column from the same function, through a new operator-only endpoint. No second checklist component.

### 3. Owner imports clients straight into a staff member's book

- `POST /:slug/contacts/import` accepts an optional `assignTo` employee id. It must belong to that business, or the whole import is refused.
- Rows whose contact has no owner get `owner_employee_id = assignTo`. A contact already in a different person's book is **not moved**; its row says "already in <name>'s book". Re-running stays safe.
- The importer on the Customers screen gets an "Add to whose book" picker (default: nobody, which is today's behaviour).

### 4. Reliable sending

- **Test to yourself:** `POST /api/my/campaigns/test { templateId, to }` sends one copy, through the same `sendWhatsAppTemplate` the campaign uses, from the staff member's number to `to` (the number they type, normally their personal WhatsApp), with their first name filled in. Not the profile number: connecting a number overwrites `employees.whatsapp_number` with that business number, and a number cannot message itself. `to` equal to the sending number is refused with that reason. It returns Meta's answer verbatim in plain words. No broadcast row, nothing counted against any limit.
- **Correct daily limit:** `describeDailyCeiling` reads the tier of the number the campaign actually sends from (`/{phone_number_id}?fields=messaging_limit_tier`, with that number's token) and counts today's usage for that number only.
- **Number health gate:** at campaign start, if Meta rates the sending number RED the campaign is refused with the reason; YELLOW is allowed with a warning on the screen.
- **Circuit breaker:** after each recipient, if at least 10 have been attempted and more than half failed, the broadcast becomes `paused` and the remaining queued sends exit without sending (their recipients stay `pending`). The staff member sees "Paused: most messages were refused — <top reason>"; the pause is logged at warn naming the business, the person and the reason. `broadcasts.status` has a CHECK constraint without `paused`, so migration **099** adds it (applied as the owner role before the deploy, per the standing migration rule).
- **Plain results:** the Campaigns list shows sent, delivered (read counts as delivered, as today), failed, and the top failure reasons translated for the common Meta codes: 131026 not on WhatsApp, 131047 outside the 24-hour window, 131049 WhatsApp limited marketing to this person, 132001 message not approved on this number, 131056 too many messages to one person. Anything else is shown verbatim.

## Out of scope

Quiet-hours scheduling, A/B tests, AI-written campaigns, sending to people who are in no one's book, re-enabling a shared company number.

## Error handling

Every network step to Meta fails soft and visibly: readiness shows "could not check" (never green) when Meta does not answer; template submission retries next sync; a test send returns the reason; the breaker only pauses on recorded failures, never on a lookup it could not make.

## Testing

- Unit: template-presence diffing (absent vs present in any status), readiness for each failing check, import assignment rules (unowned, owned by someone else, foreign employee id), breaker threshold, error-code translation, per-number ceiling selection.
- Existing suites stay green (`./scripts/check.sh`); live gates (`./scripts/verify-all.sh`) stay 12/12 after deploy.
- Live: after deploy, confirm SFS templates were submitted to Keshav's account by the first sync, run the dry-run readiness script for every staff member, and send one test message to the owner's own WhatsApp from Keshav's number once a template is approved.
