---
description: "The self-improvement loop: what this project has got wrong more than once, and what now catches it"
type: Loop
about: "nexus-agentic-os"
---

# The same mistake twice

This is feature 6 of the platform register, and it is the only one of the fifteen
that is developer tooling rather than product. It exists because of a number:
**eleven**. That is how many times one defect — a read for the serving business
made inside the number owner's transaction — has been found in this codebase,
and the eleventh was written by somebody who had spent that same week
cataloguing the other ten.

That is not a lapse of attention, and "be more careful" is not a fix for it. It
is what happens when the only place a lesson is stored is a paragraph.

## What was already here, and what was missing

This repository records its own defects unusually well. 343 commits, and the
messages name the mechanism and count the repetitions out loud:

> Nine instances of one defect, and now a check instead of a tenth
> I shipped with three red tests, for the same reason I have warned about twice today
> The eleventh instance, in code I wrote an hour ago

Three separate files warn in their headers that a pipeline swallows its exit
code. The mistake was then made three times in one day **by the author of two of
those warnings**.

So the defect record already existed. Nothing read it. The count lived in a
commit message nobody opens again, and the next session started from zero.

## The loop

```
   a defect is found
        -> recorded in scripts/recurrence/register.mjs, with its evidence
        -> a detector is written, or the impossibility is stated in writing
        -> the-same-mistake-twice.test.mjs enforces it on every commit
        -> the next instance is caught before it ships
        -> recurrence-harvest.mjs re-reads the history and says where this has
           fallen behind
```

Four pieces, and each one is only worth having because of the next.

| | |
|---|---|
| `scripts/recurrence/register.mjs` | The memory. Eight classes, each with its mechanism, instance count, evidence, and what catches it |
| `scripts/recurrence/detectors/` | The scanners. Run on every commit, not on the days somebody remembers |
| `apps/api/test/the-same-mistake-twice.test.mjs` | The teeth |
| `scripts/recurrence-harvest.mjs` | The observer. Reads git history, reports where the register has decayed, **proposes and never writes** |

## The rule with teeth

**A class that has recurred three times must name something that catches it, or
state in writing why nothing can.** Two is a coincidence; three is a pattern.
Anything else fails the suite.

`whyUncoverable` is not an escape hatch to be filled in with "hard". It is for
classes whose artifact does not exist in this repository — a mistake made at a
shell prompt leaves nothing here to scan, and for classes that are semantic
rather than syntactic. Two classes use it today, and what they say is a claim
that will be read by whoever hits that class next.

The second one earns its keep by naming the practice that DOES work where a
detector cannot: **make the failure message carry the evidence, not the
verdict.** `DOUBLE BOOKED` cost a day of guessing at a booking defect that was
not one. `2 bookings hold that slot: Ralph Ivan Simeon, Self Check Bookable`
named the cause in a single run — the gate's own fixture.

The gate also asserts that each detector **examined something**. Zero findings
and zero checks look identical from outside, and the prose detector shipped its
first version resolving every path three levels too deep: it reported a clean
tree while checking two assertions out of 219. Silent under-coverage, in the
scanner written to find silent under-coverage.

## What it found on its second day

The loop is worth having only if it finds things, so: it did, on the first
extension of it.

`an-extraction-that-found-nothing` asks whether the markers these tests search
for are still in the files they search. 244 distinct markers, 198 of them
bounding a slice, ten guarding against -1. One was stale:

`handover-brief.test.mjs` asserted that the AI is paused BEFORE the handover
summary is built. Its own comment says why — "ordering is the whole safety
property", because a slow or failing model must not delay the pause or the
employee's link. It searched for `await setConversationHandoff(conversationId,
true)`. That call gained a required `reason` argument in `ae0ec7024`, so the
marker stopped matching, and the assertion became:

```
-1 < 20538   ->   true
```

Not merely unchecked. **Actively reporting that the property held.** It would
have passed with the handoff after the brief, or with the handoff deleted
outright. 1034 tests stayed green over it.

The repair does not just correct the marker — a bare `indexOf` is what disarmed
it, so the test now asserts the marker was found before comparing, and matches
the call rather than the call plus its arguments. Verified by swapping the two
calls in the route: green before the repair, red after.

The detector's own first run reported seven findings, six of them false —
markers like `export async function ${fn}` looped over a list of real names.
Six false alarms out of seven teaches people to ignore the seventh, which was
the live defect. It now skips template literals and says how many it skipped.

## Why this is a test and not an eleventh gate

The eleven gates in `verify-all.sh` run against production and answer questions
only production can answer. This one reads source, so its answer is the same
everywhere and should be given at the commit, not after the deploy. `npm test`
is what the pre-commit hook runs.

There is also a plain reason: the VPS has no `node` outside the containers, and
test files are not in the images. A gate placed in `verify-all.sh` would have
looked like coverage and run nowhere.

## What it does not do

It does not fix anything, and it does not decide anything. The harvester will
not edit the register, for the same reason the procedure inference proposes and
never activates: deciding that two commits describe the same defect class is a
judgement, and a substring match is not qualified to make it.

Running it today reports eight commits that admit a repetition no class claims.
Two of them are the shared-number class recorded under wording the signals miss
— they name no mechanism at all, only "Record the sixth instance". That is the
tool working: it surfaces candidates, and a person decides.

## Running it

```
npm test                              # the gate, on every commit
node scripts/recurrence-harvest.mjs   # what the history says the register is missing
```
