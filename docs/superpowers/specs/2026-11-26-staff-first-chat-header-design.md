# Staff-first compact Nexus — piece 3: the open chat's header on a phone is one row

Date: 26 Nov 2026. Owner: "Yes, next piece" — after piece 2 (My queue, live at c8c61b8) named
this as the next thing staff trip over.

## What a staff member meets today (preview at 375px, 26 Nov 2026)
An open chat's header holds eight controls — customer panel, Call, Assign, Snooze, Resolve, Not
a customer, Ask a colleague, the AI / Human switch — and on a phone they wrap into a block about a
third of the screen tall, with the label row (tags plus suggestions) under it. The conversation
starts below all of that.

## The design (short: a small change)
- **Phone (≤760px) only.** The header is one row: back, the customer (name, number), **Call**
  (icon), **Resolve** (icon), the **AI / Human switch**, and **⋯** (`aria-expanded`). ⋯ opens a
  second row with the rest — customer panel, Assign, Snooze, Not a customer, Ask a colleague — and
  the label row. ⋯ again, or another chat, folds it.
- **Wider screens:** unchanged; ⋯ is not shown.
- Nothing is removed and no button changes what it does; the inbox's keyboard shortcuts and the
  command palette (Not a customer, Ask a colleague) keep working at every width.

## Approaches
- **A. Fold the secondary controls behind ⋯ on phones, by CSS on a header class.** *(Chosen:
  smallest change, every component stays as it is, wider screens untouched.)*
- B. Rebuild the secondary controls as a menu list — a menu of popovers (Snooze, Ask a colleague
  each open their own), more code and more to break.
- C. Collapse on laptops too — adds a click to the admin's frequent "Not a customer".

## Calls I made
- Primary on a phone: Call, Resolve, the AI / Human switch (the switch decides who answers next).
- The label row folds with the rest on a phone; labels still show on the list rows.
- ⋯ folds again when another chat opens.

## Testing
Source and CSS pins (the inbox page is not rendered in tests): the header class, the ⋯ button
with `aria-expanded`, the fold reset per chat, the phone-only rules, ⋯ hidden on wider screens.
Web suite and typecheck. A look in the preview at 375px and 1024px as SFS staff.

## Rollout
Web only, no migration. Deploy only on the owner's "Deploy it".
