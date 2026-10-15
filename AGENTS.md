# Working in this repository

## Read in ranges

**Never whole-read a file over ~10 KB.** Use `read` with `offset` and `limit`,
or `grep` and read around the matches. `read`'s 2000-line / 50 KB cap is not a
guard: one large tool result cannot be compacted away once it is in the
retained tail, and every later compaction still overflows. Index first (grep
the headers), then read ranges of ≤200 lines. Do not re-read the same file.

## Never truncate a search you are drawing a conclusion from

A truncated match list looks exactly like an absent one; `grep … | head` has
produced confidently wrong "this code does not exist" calls here. Before
concluding something is absent, count the matches (`grep -c`, or the `grep`
tool with no `limit`), then narrow. Truncate to read; never truncate to decide.
This is a rule about evidence, not a command: `reviewer` has no `bash` and
`researcher` has `read/write` plus web tools, so use whichever search you have.

## Return a pointer, not a report — unless you cannot write

If you have a write tool: write findings to the output path you were given and
keep the final response to the verdict plus the supporting file paths. The
detail belongs in the file, not in the parent's context.

**If you have no write tool (`reviewer`), return the complete artifact in your
final response.** The runtime persists that message to the output path; a short
answer is the whole deliverable, lost. Your run-time instructions say which
case you are in and override this file.

## Planning artifacts go to the temp dir

Write the plan, the task breakdown and any delegation records to a task
directory under the system temp directory as you go, e.g.
`$TMPDIR/pi-plans/<task-id>/` — `mkdir -p` it; it will not already exist.
The temp dir is on disk, so these survive a reboot, and it is
periodically cleaned up; never treat the files as durable and never
`git add` anything under them.

The **GitHub issue is the task and acceptance tracker** for the flow: keep
the issue's task list and acceptance notes up to date instead of a
per-flow ledger file — a ledger file is no longer needed.

## Coding workflow (user preference, 2026-10-12)

- The plan goes to the task directory under the system temp directory as
  described in "Planning artifacts go to the temp dir" above — not to a
  repo-local `plans/` dir and not to a bare path in `/tmp`.
- Code-editing work follows a loop: scout (find and highlight the problem)
  → planner (a subagent reviews the findings and proposes a plan) →
  implementer (a worker executes the plan) → reviewer → fix-up round, looped
  until it works or a human is needed. Skip a step only when it clearly does
  not apply.
- Large crawl/audit tasks are split into small parallel crawlers, each
  writing raw findings to disk; a synthesizer then merges them into the final
  report.
- Dispatch as many independent read-only tasks in parallel as the work
  allows.

## Review and PR conventions (user preference, 2026-10-14)

- Every code change gets an adversarial review by a fresh reviewer before its PR is opened: the reviewer reads the full diff and reports verdict first (verdict, then findings with file:line, then evidence). Findings get a fix-up round and a fresh re-review until the verdict is clean.
- PR titles, bodies, comments, and commit messages are plain English that a human understands on their own — no internal task, wave, tranche, or agent terminology.
