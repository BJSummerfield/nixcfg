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

## Planning artifacts go in `.plans/`

Write the plan, the task breakdown and any delegation records to `.plans/` as
you go: `.plans/<slug>.md` for a single plan, or `.plans/<slug>/` holding
`plan.md`, `tasks.md` and `delegations/` when the work fans out to sub-agents.
`mkdir -p` it; it will not already exist.

`.plans/` is untracked and is **not** in `.gitignore` — that is deliberate, so
the files stay visible in a git status viewer. Never `git add` anything under
it. The `.githooks/pre-commit` hook unstages `.plans/` (aborting the commit
only if that was the sole staged change), so a stray `git add .` is recovered
rather than fatal, but do not rely on it. Nothing in `.plans/` is durable:
`git clean -fd` removes it, and the
directory dies with the worktree.

## Coding workflow (user preference, 2026-10-12)

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
