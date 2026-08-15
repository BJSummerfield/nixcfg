---
name: adversarial-plan-review
description: Use when all tasks of an implementation plan are complete and per-task reviews passed, before calling a branch merge-ready or invoking finishing-a-development-branch
---

# Adversarial Plan Review

One final review pass, on the most capable available model, over the
whole plan and the whole branch at once. Per-task reviews gate each
task's diff; this pass hunts the defects only the whole-branch view
exposes.

**Violating the letter of this gate is violating its spirit.** The
branch is not merge-ready until this pass has run and every Critical
and Important finding is fixed or adjudicated with a written ruling.

## When to Use

- After every implementation-plan execution, whatever the workflow:
  subagent-driven-development, executing-plans, sp-implement,
  sp-implement-parallel, or manual.
- In subagent-driven-development, this pass IS the final whole-branch
  review: dispatch it with
  [adversarial-reviewer.md](adversarial-reviewer.md) instead of the
  compliance-oriented code-reviewer template.
- Not for single-task changes with no plan — requesting-code-review
  covers those.

## Process

1. Package the inputs: whole-branch diff (merge-base → HEAD), plan
   path, spec path, and the ledger's deferred/parked findings. (Under
   SDD, `scripts/review-package PLAN_FILE MERGE_BASE HEAD` builds the
   diff package.)
2. Dispatch ONE read-only reviewer subagent on the most capable
   available model — never the session default — using
   [adversarial-reviewer.md](adversarial-reviewer.md). Under
   pi-superagents, dispatch sp-review with `Review scope: branch`.
3. Findings → ONE fix wave (a single subagent with the complete
   findings list), then ONE scoped re-review. Adjudicate residuals:
   park with rulings, or stop and report load-bearing ones.
4. Only then is the branch merge-ready and
   finishing-a-development-branch allowed.

## Why per-task review is not enough

A real run shipped two structural bugs (an invariant hole that
produced saved-but-unloadable state, and an over-rejecting parser)
through 11 clean per-task reviews with 0 fix rounds. The same plan
run WITH this pass caught both, plus two spec-coverage gaps. All four
lived across task boundaries, in code whose per-task diffs were
individually correct.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Every task review passed" | Task reviews are task-scoped. The defects this pass exists for are invisible in any single task's diff. |
| "0 fix rounds — it was a clean run" | Clean tasks say nothing about the seams between them. The run that shipped the bugs was a 0-fix-round run. |
| "The plan was thorough" | This pass reviews the plan too. A plan-mandated defect is still a defect. |
| "Too expensive / too slow" | Observed cost: minutes of review plus one fix wave. Observed alternative: corrupted-state bugs in a merged PR. |
| "The last task review saw the final state" | It saw the last diff. Nobody re-read the whole branch against the whole spec. |
| "I'll just review it myself in-session" | The controller's context is polluted by every dispatch it made. Fresh subagent, most capable model, or it doesn't count. |

## Red Flags — STOP

- About to invoke finishing-a-development-branch with no adversarial
  pass recorded in the ledger
- Declaring "merge-ready" citing only per-task reviews
- Dispatching the final review on the session-default model
- Skipping the pass because the diff "is small" — small branches
  still drift from their specs
