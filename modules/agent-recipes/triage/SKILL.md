---
name: triage
description: Read the receipt of a research run and decide what to tell the user about its open items. Use after a research run ends.
---

# Triage

The research script handles failures itself, so nothing is dispatched from
here. It follows these rules:

| Situation | What the script does |
|---|---|
| A child fails by itself (engine error, no turns) | Retries it once under a new key |
| A check rejects a child's file (no sources, no quotes) | Records it; no retry |
| An extract is over 24 KB | Redoes it as two extractors, each covering half the page's sections by its outline |
| Either half is still over 24 KB or fails | Records the source as over the cap or failed |
| The notes exceed half the window | One synthesizer per angle group, then one to combine them |
| The reviewer lists open gaps | One gap round, then an update of the output |
| A synthesizer or reviewer fails twice, or the verdict cannot be read | A diagnose child picks continue, retry or decide; at most two per run |
| Anything else | Records it in `open` |

## Reading the receipt

`{ output, sources: { ok, failed, over_cap }, healed, decide, open, gap_round, children }`

- `output` is null when no source was found, no extract passed its check or
  the synthesizer failed; `open` says which.
- Each `open` entry is one line: a failed or over-cap source with its URL, a
  search or angle that produced nothing, a gap the extra round could not
  close, or the review's verdict when it was not clean (see `review.md`).
- `gap_round` true means one extra round already ran; there is no second.
- `healed` lists what a diagnosis recovered, one line each; `decide` lists
  the questions a diagnosis left for the user, each with its diagnosis file.

## What to tell the user

Report the output path first. Then each `decide` question with its diagnosis
file, the counts, what healed, and each `open` entry in one line. A `decide`
question, a failed source or an unclosed gap is the user's call: a new
research run, a narrower goal, or accepting the gap. Do not start another run
unasked.
