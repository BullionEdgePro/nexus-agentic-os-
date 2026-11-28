# A unit card chooses its agent

Date: 28 Nov 2026. Owner: "Yes, build it" — found while preparing SFS's Bayut listing.

## The gap
A unit's agent is set once, when the unit is made: the staff member who adds it (packages/db
workflow-board createUnit: `agent = fields.agentEmployeeId ?? employeeId`). A unit an admin adds
gets nobody, and the card has no way to choose — the API accepts `agentEmployeeId` on a unit
(PATCH), but no screen sends it. Every portal needs "an agent on the card" (portalProblems), so a
unit an admin adds can never be advertised, and staff cannot hand a unit to a colleague.

## The design (small change)
- The unit card shows **Agent** under its header: a choice of the business's active staff and
  "Nobody yet", on the current agent. Choosing saves at once through the card's own save
  (`onSave({ agentEmployeeId })`), as the Bayut location does.
- The staff list is the one Follow-ups already uses (`getTeam(slug)`, active members), loaded by
  the board panel once per business and passed to the card as `agents`. Until it arrives, or if it
  fails, the card shows the agent's name as today and no choice.
- An agent no longer on the active list (left the staff) still shows as the current choice.
- "View as staff" (`canEdit` false): the name only.
- Deals are unchanged: a deal's agent already falls back to the customer's owner.

## Approaches
- **A. A choice on the card, staff list from `getTeam`.** *(Chosen: web only; the API already
  takes the field and checks the person is staff.)*
- B. Add the staff list to the board's answer — an API and shared-type change for a list the web
  can already ask for.
- C. Let only the Add unit form choose — leaves every existing card unfixable.

## Testing
Render tests of the card (choice shown with options and current value; none for View as staff,
for deals, or before the list loads; a departed agent still selected); a source pin that the board
panel loads the team and passes it. Web suite and typecheck; preview as admin and staff.

## Rollout
Web only. Deploy on the owner's "Deploy it".
