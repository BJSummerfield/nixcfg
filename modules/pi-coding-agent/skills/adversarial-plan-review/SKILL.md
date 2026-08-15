---
name: adversarial-plan-review
description: Use when all tasks of an implementation plan are complete and per-task reviews passed, before calling a branch merge-ready or invoking finishing-a-development-branch
---

# Adversarial Plan Review

One final review over the whole plan and the whole branch at once, on
the most capable available model. Per-task reviews gate each task's
diff; this pass hunts the defects only the whole-branch view exposes.

**The template file IS the review.** Everything a reviewer must do —
including the hunt procedures — lives only in
[adversarial-reviewer.md](adversarial-reviewer.md), deliberately. On
the same model and the same code, a dispatch carrying that file
verbatim found a Critical and two Importants; a dispatch carrying a
paraphrase of it found nothing. Summarizing the template deletes the
review.

**Violating the letter of this gate is violating its spirit.** The
branch is not merge-ready until this pass has run and every Critical
and Important finding is fixed or adjudicated with a written ruling.

## When to Use

- After every implementation-plan execution, whatever the workflow:
  subagent-driven-development, executing-plans, sp-implement,
  sp-implement-parallel, or manual.
- In subagent-driven-development, this pass IS the final whole-branch
  review — dispatched per the contract below, not with the
  compliance-oriented code-reviewer template.
- Not for single-task changes with no plan — requesting-code-review
  covers those.

## The dispatch contract

Every reviewer dispatch consists of exactly:

1. The complete fenced prompt from
   [adversarial-reviewer.md](adversarial-reviewer.md), copied
   verbatim this session — every section, every hunt class, unedited
   and unreordered.
2. The brackets filled: paths, SHAs, ledger lines, and
   `[HUNT_CLASSES]` as bare numbers.

Nothing else. A dispatch that restates, abridges, reorders, or adds
its own wording of any hunt class is invalid — discard it and
re-dispatch from the file. Reviewers may be running read-only on the
repo (sp-review is): they return findings in their reply, and the
CONTROLLER appends each reply verbatim to the findings file before
the next dispatch.

## Process

1. Build the inputs: commit list + `git diff --stat MERGE_BASE..HEAD`
   redirected to one file (never the full unified diff), plan path,
   spec path, the ledger's deferred/parked lines. Create an empty
   `findings.md` in the plan workspace.
2. Dispatch THREE reviewers, sequentially, fresh context each, per
   the contract, on the most capable available model — never the
   session default. Under pi-superagents: sp-review (the template's
   first line carries its required scope marker).
   - **Hunt pass A:** `[HUNT_CLASSES]` = `1 2 3 4 5 6`, findings file
     marked `none yet`.
   - **Hunt pass B:** the identical dispatch, told nothing about
     pass A. Independent samples are the point: on this exact review,
     two passes of the same model have disagreed on a Critical — one
     caught an invariant hole the other cleared as safe. One pass is
     a coin flip; the union is the review.
   - **Adjudication pass:** `[HUNT_CLASSES]` = `6`, with the findings
     file now holding both hunt replies — dedupe, re-grade, rule on
     deferred items, verdict.
   After every dispatch, append its reply verbatim to `findings.md`.
3. Findings → ONE fix wave (a single subagent with the complete
   adjudicated findings list), then ONE scoped re-review — it sees
   only the fix diff and the findings list. On a Critical finding the
   re-review may challenge the fix's direction, not just its match to
   the finding. Adjudicate residuals: park with rulings, or stop and
   report load-bearing ones.
4. Only then is the branch merge-ready and
   finishing-a-development-branch allowed.

## Adding this pass to a plan

A plan step may only point here — never describe the process:

> - [ ] **Final gate: adversarial plan review.** Invoke the
>   adversarial-plan-review skill: read its SKILL.md this session and
>   follow it exactly. Dispatch prompts are the verbatim contents of
>   its adversarial-reviewer.md with brackets filled. Do not restate
>   either file's content in this plan or in any dispatch.

If a plan (or any prior note) contains a summary of this skill's
process, the skill files govern and the summary is void.

## Why per-task review is not enough

A real run shipped two structural bugs (an invariant hole producing
saved-but-unloadable state, and an over-rejecting parser) through 11
clean per-task reviews with 0 fix rounds. Runs of the same plan WITH
this pass caught the invariant hole and more — every such defect
lived across task boundaries, in code whose per-task diffs were
individually correct.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Every task review passed" | Task reviews are task-scoped. The defects this pass exists for are invisible in any single task's diff. |
| "The plan already describes the review step" | A plan summary is a lossy copy of a lossy copy. The template file is the only source; plans may only point at it. |
| "I'll summarize the template to keep the packet small" | The observed cost of a summarized packet was a review that found zero of the bugs present. Packet tokens are the cheapest thing in this pass. |
| "Pass A was thorough — skip pass B" | Pass A of a real review cleared, with a written evidence trail, the exact Critical that an identical pass had caught the day before. Thoroughness does not reduce variance; independence does. |
| "Reviewing is reading; tests are the implementer's job" | A reviewer that only reads has marked broken invariants clean. The attack test in the scratch copy IS the review. |
| "Too expensive / too slow" | Observed cost: minutes of review plus one fix wave. Observed alternative: corrupted-state bugs in a merged PR. |
| "I'll just review it myself in-session" | The controller's context is polluted by every dispatch it made. Fresh subagent, most capable model, or it doesn't count. |

## Red Flags — STOP

- About to invoke finishing-a-development-branch with no adversarial
  pass recorded
- Declaring "merge-ready" citing only per-task reviews
- Dispatching any review pass on the session-default model
- A dispatch containing your own wording of any hunt class, or
  composed without reading adversarial-reviewer.md this session
- Skipping hunt pass B, or letting pass B see pass A's findings
- Handing any reviewer the full unified branch diff
