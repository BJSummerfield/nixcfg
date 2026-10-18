# How long tasks are run

## Reading the request

- The opening words pick the mode, in any phrasing: implement, build, fix;
  flesh out, plan out ("flush out" counts); research, look into; work
  through, queue up. Spoken and written issue numbers are the same issue. A
  size word sets the fan-out: quick (one helper or none), loop (default:
  scout, plan, do, review), fleet (as wide as the work splits); "grill me"
  or "dig deep" is the deep size of flesh out.
- Anything else, including a question that mentions an issue, is a quick
  ask: answer it, start nothing.
- No loop starts without a go. Answer, and if a loop looks wanted end with
  one line naming mode, size, target and ending ("Sounds like: flesh out
  issue 284, loop, ends with drafted issues. Say go."). An ambiguous opening
  gets one short question, never more.
- Implement and queue also need the `ready-for-agent` label and an unchecked
  criterion on the issue; otherwise say so in one sentence and stop.
- Never narrow a big ask to fit; split it.

## The main session dispatches; it does not work

It reads state files, first lines and verdicts; runs `gh`, `mkdir`, the
dispatch tool and read-only git (`log`, `status`); never reads source,
builds, or changes anything with git. One turn per phase; everything else is
a helper's task.

## State lives in the task directory

`$TMPDIR/pi-plans/<slug>/` (`issue-<N>` for issue work, else a short name):
`state.json` (phase, next action), `issue.md`, `raw/`, `synthesis.md`,
`plan.md`, `tasks/`, `review-<r>.md`; flesh out adds `decisions.md`,
`raw/facts/` and `issues/`. Written at each phase boundary, re-read rather
than remembered:
after a compaction or restart read `state.json` first; files and `git log`
are right, memory is wrong; a task with a result file is finished; an
existing directory means resume. A loop that stops short leaves `handoff.md`
(done, open, do first; pointers, not copies). The directory is scaffolding
and may be aged out; the deliverable goes where the user asked.

## Handoffs are files

A helper gets paths, writes its deliverable where told, and replies with one
first line (`done`, `done, concerns`, `blocked: why`, `failed: why`, or a
review verdict) plus the path. A missing result is a recorded failure, never
filled in.

## GitHub text is for humans

Issues, PRs, comments and commits stand alone: no run or role names,
severity codes or temp paths. An issue holds the problem and the acceptance
criteria only; sub-issues carry their order (`gh issue create --parent P
--blocked-by A,B`). A parent that declares an order gets an integration
branch `issue-<parent>`: its sub-issue PRs target it and the session may
merge one there after a clean review, never into main. Independent issues
target main and wait for a human.

## Review ends a loop

A fresh reviewer, the full diff or deliverable, verdict first in two parts:
does it do what was asked; is it sound. Clean: no blocking finding in either
and the stated check passed. Small findings are recorded, not looped. Fix
rounds 1 and 2 return to the same implementer with the findings; round 3 is
a fresh implementer with more thinking; after that, a round that changed
nothing, or a reviewer that cannot hold the change: stop and hand the open
findings to the user.

## The modes

- Implement: prepare the branch > scouts and researchers > synthesis > plan
  and a short plan review > implementers, one worktree each > merge and the
  heavy checks once, under the lock the environment file names > review > PR
  saying `Closes #N`, or a stop note. Too big for one review: the finished
  piece becomes the first sub-issue and PR, the rest sub-issues in order;
  stop for the user.
- Flesh out: quick writes `plan.md` from what is known; loop adds scouts,
  researchers and synthesis, shows the plan for voice edits and asks nothing;
  deep adds question rounds before the plan. All end with `plan.md` played
  back in spoken-length sections, guesses marked, a builder check by a fresh
  reviewer, and drafts in `issues/`: a parent, sub-issues as narrow complete
  slices in blocking order, and an unlabelled "Decide: ..." sub-issue per
  open decision, blocking what waits on it. Filed only on "file them".
- Research: angle plan > researchers and scouts in parallel > one synthesizer
  (two past half a window of raw notes) > optional review > `summary.md`,
  whose first section is the answer.
- Queue: list the parent's sub-issues or the label's issues in
  `queue-<name>/state.json`; run implement for each issue whose blockers have
  landed, in its own task directory; write and re-read the queue after each;
  an issue without the label is recorded as `not labelled` and left alone.
  Ends when the list is done, every remaining issue waits on an unmerged PR,
  the stop rule fires, or its context keeps overflowing.

## Deep flesh out

`decisions.md` is the only memory, in numbered entries the planner shapes.
One round per turn: read this round's entries; speak up to four questions,
each with your recommended answer ("yes" takes them all), then how many
remain; dispatch lookups for anything that can be looked up, never ask the
user a fact; wait; write the answers; dispatch the planner for the next
round. An answered entry is never asked again. Stop on the user's word, the
round budget they named, or an empty frontier; the builder check's items are
the last round.
