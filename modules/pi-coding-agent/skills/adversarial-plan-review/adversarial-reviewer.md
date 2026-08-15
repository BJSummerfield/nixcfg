# Adversarial Plan Reviewer Prompt Template

Dispatch ONE read-only reviewer per hunt-class group on the most
capable available model. Under pi-superagents, dispatch sp-review (it
pins the max tier) and keep the `Review scope: branch` line —
sp-review requires it. Fill every [BRACKET]. `[HUNT_CLASSES]` is
"1 2 3 4 5 6" for a single-dispatch review, or the group's classes
under the split protocol (see SKILL.md step 3b).

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
- What changed: [STAT_PATH] (commit list + diff --stat for merge base
  [BASE_SHA] → head [HEAD_SHA]; the branch is checked out at HEAD, so
  the tree in front of you IS the code under review)
- Findings file: [FINDINGS_PATH] — append your findings here
- Hunt classes assigned to this dispatch: [HUNT_CLASSES]
- Deferred/parked ledger findings: [LEDGER_LINES_OR_PATH]
  (relevant only if class 6 is assigned)

## Context discipline

Work from the tree, never from a bulk diff. For each hunt: grep for
the symbols, claims, or patterns it implicates, then read only the
files the grep implicates. Do not read the full unified branch diff,
and do not re-read what you can re-grep. Your investigation budget is
turns, not context residency — a fact you need twice is a fact you
grep twice.

## Read-only review

Do not mutate the working tree, the index, HEAD, or branch state.
Inspect history with `git show`, `git diff`, `git log`. If you need a
working copy of another revision, use a temporary worktree
(`git worktree add /tmp/review-[SHA] [SHA]`), never this checkout.

## The hunt classes — work each assigned class fully, in order

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
   one-line justification. Then read the findings file written by
   earlier dispatches: dedupe overlapping findings, re-grade anything
   over- or under-stated, and issue the verdict.

## Findings discipline

Every Critical or Important finding needs a file:line reference and a
concrete failure scenario: the exact call sequence or input, and the
wrong outcome it produces. A finding you cannot make concrete is a
question, not a finding — record it separately, do not inflate it.

## Output

Append to [FINDINGS_PATH], under a `## Dispatch [HUNT_CLASSES]`
heading, each finding as:

- `[Critical|Important|Minor]` file:line — what is wrong; the failure
  scenario; a fix sketch if not obvious.
- `[Question]` — anything suspicious you could not make concrete.

If class 6 is assigned, end the file with:

### Verdict
MERGE-READY or NOT MERGE-READY, one line of justification.
### Deferred-finding rulings
One line per ledger item: fix-before-merge or deferred, and why.

Return to the controller only: counts per severity, and the verdict
line if class 6 was assigned. The findings file is the record — do
not restate it in your reply.
```
