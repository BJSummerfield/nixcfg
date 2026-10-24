---
name: research
description: Answer a question from web sources, a repository, or both: a planner splits it into angles, searchers (or locators) list sources, extractors copy out passages, a synthesizer writes the output and a reviewer checks it, all run by a script. Use only when the user asks for research.
disable-model-invocation: true
---

# Research

Parameters, from the request:

- goal: the question, in one or two sentences.
- output: the format and location the user wants. Without one, use
  `summary.md` in the task directory, whose first section answers the goal.
- optional `source`: `web` (default), `repo` or `both`; `repo`, the absolute path of the repository, is required for `repo` and `both` (without it the run ends with an open line).
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
   angles, duplicates dropped, at most 12. With `source: repo` one locator
   per angle (`recipe-gate paths`) lists files and line ranges in `repo`
   instead, without reading them; with `both` the searchers and locators run
   together and their lists are ranked as one. The gap round uses the same
   source.
3. One extractor per source saves the page (for a file, reads the named
   file and range) and copies out the passages that
   bear on the goal, verbatim (`recipe-gate extract`; each file under 24 KB).
   Searchers and extractors run at most 3 at a time.
4. A child that fails on its own (not a rejected check) is retried once; a child that
   reported its own work as not done is not retried, and its result goes on to
   the step's normal handling. An
   extract over the cap is redone as two extractors, each covering half the
   page's sections by its outline; an extract of a file with a known line
   range is redone as two, each covering half the range, and one without a
   range is recorded. Anything else is recorded.
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
   records it. A synthesizer or reviewer that reaches its budget writes what
   it has and lists the input it did not read; fresh ones of the same role
   cover that input, and a last one merges the parts into the file the graph
   goes on with. One that hands off without listing unread input is treated
   as failed, and its partial file is not read as a verdict.
8. At each stage the script emits a board (stage, source counts, gap round,
   what healed, what needs a decision); `recipe-status <task dir>` prints it
   with the children still running.

## pi binding

One call starts the whole run; nothing else is needed from this session until
it ends.

```
recipe_run({
  recipe: "research",
  args: { dir: "<task dir>", goal: "<goal>", output: "<output path>", format: "<format>" },
  timeoutMs: 5400000,
  maxChildren: 120
})
```

All paths are absolute. The call returns at once and this session is woken once when the run ends, so do
not poll, sleep or check on it. Then read `<task dir>/receipt.json`, the whole
receipt. `recipe-status <task dir>` shows progress from any shell, and
after a pi restart `recipe-run wait <task dir>` waits for the end. A stopped
run continues with the same call plus `resume: true`.

```
{ output, sources: { ok, failed, over_cap }, healed: [{id, step, action, reason}],
  decide: [{id, step, question, diagnosis}], open: [...], gap_round, children }
```

Read the receipt with the triage skill.

## Claude Code binding

The same graph runs with Claude Code children; this session only starts it and
reads the result.

```
recipe-run start research --harness claude --args '{"dir":"<task dir>","goal":"<goal>","output":"<output path>","format":"<format>"}' --timeout-ms 5400000 --max-children 120
```

All paths are absolute. It returns at once. Then run `recipe-run wait <task dir> --timeout-ms 7000000`
with Bash in the background and a Bash timeout of 7200000. Exit 3 means the
wait timed out while the run is still going: run the same wait again. On exit 0
or 1 read `<task dir>/receipt.json`, the
whole receipt, and report as in the pi binding. `recipe-status <task dir>`
shows progress from any shell. A stopped run continues with `recipe-run resume
<task dir> --detach`.
