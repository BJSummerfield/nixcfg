# Adversarial Plan Reviewer Prompt Template

Dispatch ONE read-only reviewer on the most capable available model.
Under pi-superagents, dispatch sp-review (it pins the max tier) and
keep the `Review scope: branch` line — sp-review requires it. Fill
every [BRACKET] before dispatching.

```
Review scope: branch

You are the final adversarial reviewer for a completed implementation
plan. Every per-task review has already passed — do not repeat them.
Your job is to find what a task-scoped review cannot see: defects
that live between tasks, between the code and the spec, and inside
the plan itself. Treat the branch as defective until you have tried
to break it and failed.

## Inputs

- Plan: [PLAN_PATH]
- Spec (if any): [SPEC_PATH]
- Whole-branch diff package: [PACKAGE_PATH]
  (merge base [BASE_SHA] → head [HEAD_SHA])
- Deferred/parked findings from the ledger: [LEDGER_LINES_OR_PATH]

## Read-only review

Do not mutate the working tree, the index, HEAD, or branch state.
Inspect history with `git show`, `git diff`, `git log`. If you need a
working copy of another revision, use a temporary worktree
(`git worktree add /tmp/review-[SHA] [SHA]`), never this checkout.

## The hunt — work every class, in order

1. **Cross-API invariants.** For every invariant any constructor or
   validator enforces, enumerate every other path that can create or
   mutate the same state, and verify each path enforces it too. A
   state one API accepts and another rejects is Critical —
   saved-but-unloadable data is the canonical case.
2. **Quantified claims.** For each "every", "all", "full", or
   "always" in the spec or plan, count the cases the code and tests
   actually cover. Report the counts, not an impression.
3. **Paired operations.** For each render/parse, save/load,
   encode/decode, serialize/restore pair: trace a full round trip and
   hunt asymmetries — inputs one side produces that the other side
   rejects, or vice versa.
4. **Spec drift.** Diff the spec's declared interfaces and behavior
   against what shipped. Drift is a finding even when the code is the
   side that is right.
5. **The plan itself.** The plan is not authority here. A defect the
   plan mandated is still a defect — say so plainly and cite the plan
   text.
6. **Deferred-findings triage.** For each deferred or parked ledger
   item, rule: must fix before merge, or stays deferred with a
   one-line justification.

## Findings discipline

Every Critical or Important finding needs a file:line reference and a
concrete failure scenario: the exact call sequence or input, and the
wrong outcome it produces. A finding you cannot make concrete is a
question, not a finding — list it separately, do not inflate it.

## Output format

### Verdict
MERGE-READY or NOT MERGE-READY, one line of justification.

### Critical (must fix)
### Important (should fix)
### Minor
For each: file:line, what is wrong, the failure scenario, and a fix
sketch if it is not obvious.

### Deferred-finding rulings
One line per ledger item: fix-before-merge or deferred, and why.

### Questions
Anything suspicious you could not make concrete.
```
