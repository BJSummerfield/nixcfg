---
name: research
description: Answer a question from web sources: a planner splits it into angles, searchers list sources, extractors copy out passages, a synthesizer writes the output and a reviewer checks it, all run by a script. Use only when the user asks for research.
disable-model-invocation: true
---

# Research

Parameters, from the request:

- goal: the question, in one or two sentences.
- output: the format and location the user wants. Without one, use
  `summary.md` in the task directory, whose first section answers the goal.
- optional limits: `maxSources` (at most 12), `window` (default 221184
  tokens), `childTimeoutMs`, `bigTimeoutMs`.

The task directory is `$TMPDIR/pi-plans/<slug>/` and may be cleaned up at any
time; an output the user wants to keep goes elsewhere. The run writes
`angles.md`, `raw/search/`, `pages/`, `raw/extract/`, `synthesis-*.md` when
the notes are too big for one synthesizer, `review.md`, `diagnosis-<n>.md`
and the receipt. A retried child writes beside the file it replaces
(`<name>.retry.md`), a step a diagnosis runs again writes `<name>.2.md`, and
the gap round writes the updated output beside the first one
(`<name>.updated.md`); the receipt's `output` names the final file.

## What runs

1. A planner writes two to four angles (`recipe-gate angles`).
2. One searcher per angle lists sources without reading them
   (`recipe-gate urls`); sources are ranked primary first, round-robin across
   angles, duplicates dropped, at most 12.
3. One extractor per source saves the page and copies out the passages that
   bear on the goal, verbatim (`recipe-gate extract`; each file under 24 KB).
   Searchers and extractors run at most 3 at a time.
4. A child that fails on its own (not a rejected check) is retried once; a child that
   reported its own work as not done is not retried, and its result goes on to
   the step's normal handling. An
   extract over the cap is redone as two extractors, each covering half the
   page's sections by its outline. Anything else is recorded.
5. One synthesizer writes the output. When the extracts exceed half the
   window it is one synthesizer per angle group, one after another, then one
   that combines them. Only one large step runs at a time.
6. A reviewer checks the output against the extracts and lists open gaps
   (`recipe-gate gaps`). If it lists any, one more round runs for those gaps
   only, and the synthesizer updates the output. There is no second round.
7. A synthesizer or reviewer that failed twice, or a review whose verdict
   cannot be read, goes to a diagnose child (a fresh reviewer, diagnosis
   variant) at once. It picks one action that `recipe-gate diagnosis` checks:
   `continue` (the verdict is plain but in the wrong place; the review's gaps
   still count), `retry` or `decide`. The run gets at most two diagnoses,
   and the same diagnosis twice counts as `decide`. Failed searchers and
   extractors are not diagnosed: the run goes on without that source and
   records it.
8. At each stage the script emits a board (stage, source counts, gap round,
   what healed, what needs a decision); `recipe-status <task dir>` prints it
   with the children still running.

## pi binding

One call starts the whole run; nothing else is needed from this session until
it ends.

```
subagent({
  workflow: "/home/agent/.pi/agent/recipes/research/workflow.js",
  args: { dir: "<task dir>", goal: "<goal>", output: "<output path>", format: "<format>" },
  async: true,
  output: "<task dir>/receipt.md",
  options: { timeoutMs: 5400000, maxSubagentSpawnsPerRun: 120 }
})
```

All paths are absolute. Wait for the single completion with `bg_wait`; do not
poll, steer or read intermediate files. Then read only the receipt,
`<task dir>/receipt.md`.

The receipt file is a one-line summary whose Return part is the receipt JSON
cut at 1,000 characters; a long `open` list is cut short. The summary names
the run's `status.json`, whose `workflow.value` holds the whole receipt; read
that when the Return part ends in an ellipsis.

```
{ output, sources: { ok, failed, over_cap }, healed: [{id, step, action, reason}],
  decide: [{id, step, question, diagnosis}], open: [...], gap_round, children }
```

A child that fails inside the workflow can wake this session once with a
"Workflow child failed" notice, even though the script retries it; pi-subagents
silences only successful children and has no option for failed ones. Ignore
the notice and keep waiting for the workflow's own completion.

A child can also ask this session a question with a supervisor request while
the run goes on. Do not answer the question itself: the script decides what
happens to a stuck child. Reply that it should stop and write `blocked:` and
its question as the first line of its report, then keep waiting.

Read the receipt with the triage skill.

## Claude Code binding

Claude Code runs no pi-subagents workflow script: its Workflow tool has a different
child API and must be opted into per run, and a headless `claude -p` runner for
the same script has not been built. So the main session does the script's work
with the Agent tool, one `subagent_type` per role (`planner`, `searcher`,
`extractor`, `synthesizer`, `reviewer`; their definitions are installed), in
the same order and with the same `recipe-gate` checks. Turns in the starting
session are unavoidable here.

1. Dispatch `planner` for the angles job, writing `<dir>/angles.md`. Run
   `recipe-gate angles <dir>/angles.md`; use at most four angles.
2. Dispatch one `searcher` per angle, at most 3 in one message, writing
   `<dir>/raw/search/search-<id>.md`; run `recipe-gate urls` on each file.
3. Rank and cap as above, then dispatch one `extractor` per URL, at most 3 at
   a time, writing `<dir>/raw/extract/extract-<k>.md`; run `recipe-gate
   extract` on each. Retry a helper that died once. For an over-cap file,
   remove it and dispatch two extractors told to cover the first and the
   second half of the page's sections, writing `extract-<k>a.md` and `...b.md`.
4. Run `recipe-gate size <dir>/raw/extract`. With `split` 1 dispatch one
   `synthesizer` with the goal, the format, the extract files and the output
   path. With more, group the extracts by angle, run one `synthesizer` per
   group one after another, then one more to combine them.
5. Dispatch a `reviewer` (research deliverable variant) writing
   `<dir>/review.md`, and run `recipe-gate gaps <dir>/review.md`. If it lists
   gaps, run steps 2 to 3 once for them with ids prefixed `gap-`, then a
   `synthesizer` that updates the output with the new extracts.
6. Where the pi script diagnoses (step 7 of What runs), dispatch a fresh
   `reviewer` (diagnosis variant) with the step, what went wrong, the evidence
   files, the allowed actions and `<dir>/diagnosis-<n>.md`, read it with
   `recipe-gate diagnosis <file> --allow <actions>`, and act on it with the
   same limits. Do not decide in its place: a `decide` goes to the user.
7. Write `<dir>/receipt.md` in the receipt shape above, counting every helper
   dispatched.
