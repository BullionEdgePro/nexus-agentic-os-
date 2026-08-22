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
| `scripts/recurrence/register.mjs` | The memory. Six classes, each with its mechanism, instance count, evidence, and what catches it |
| `scripts/recurrence/detectors/` | The scanners. Run on every commit, not on the days somebody remembers |
| `apps/api/test/the-same-mistake-twice.test.mjs` | The teeth |
| `scripts/recurrence-harvest.mjs` | The observer. Reads git history, reports where the register has decayed, **proposes and never writes** |

## The rule with teeth

**A class that has recurred three times must name something that catches it, or
state in writing why nothing can.** Two is a coincidence; three is a pattern.
Anything else fails the suite.

`whyUncoverable` is not an escape hatch to be filled in with "hard". It is for
classes whose artifact does not exist in this repository — a mistake made at a
shell prompt leaves nothing here to scan. One class uses it today, and what it
says is a claim that will be read by whoever hits that class next.

The gate also asserts that each detector **examined something**. Zero findings
and zero checks look identical from outside, and the prose detector shipped its
first version resolving every path three levels too deep: it reported a clean
tree while checking two assertions out of 219. Silent under-coverage, in the
scanner written to find silent under-coverage.

## Why this is a test and not an eleventh gate

The ten gates in `verify-all.sh` run against production and answer questions
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
