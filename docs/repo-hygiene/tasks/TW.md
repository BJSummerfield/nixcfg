# TW — The walk

`invariant: drvPath` (trivially — read-only, nothing changes).

Output: `docs/repo-hygiene/LEDGER.md`. This is the single survey that T5, T6,
T7, T8, T13 and GATE 2 all consume instead of re-deriving. Its quality sets a
ceiling on all of them.

## Shape
Fan out one cheap agent per module directory (plus one for `hosts/`, one for
`tests/`, one for the repo root + `ci/` + `.github/`). Each agent gets
`RUBRIC.md`, `tasks/R4.md`, and its own directory. No agent reads another's
files. No agent edits anything.

Per `.nix` file, at most a dozen lines:
1. **Purpose** — reason to exist, one sentence, no "and" (rubric B5).
2. **Does** — enumerated, each entry with why it is here. Verdict
   *coherent* / *table* / *overloaded*, and for overloaded: what should move
   out, and **where to**. Naming the destination is the point; "split this" is
   not a finding.
3. **Comments** — count failing rubric A by category (A1 restatement /
   A2 history / A3-A5 justification-and-prose), plus the few that clearly earn
   their place, quoted short. The ratio is a smell detector, not a limit.
4. **Idiom** — R4 checklist hits, plus any place this file solves a problem the
   repo already solves differently. Cited per G4 (file:line old, the
   replacement, where the replacement already lives). Filtered by G3: shorter,
   harder to get wrong, or removes a hand-rolled thing upstream now owns.
   "Newer" is not a reason.
5. **Namespace** — for each option the file declares: would a reader predict
   `mine.system.*` or `mine.user.*`? One line per miss only. (Absorbs T11.)
6. **Confidence**, and anything it could not judge.

Plus two cross-file sections the per-file agents cannot produce:
- **Idiom summary** — the G1 findings only appear when you look across modules.
  N spellings of one idea, which is newest, which files diverge.
- **Namespace summary** — the GATE 2 decision input: is there real incoherence
  worth a rename task, or is this a documented no-op?

## What R4 already settled — do not re-flag
`tasks/R4.md` checked these repo-wide and found **zero** instances:
`types.string`, `types.loaOf`, file-scope `with lib;`, hand-rolled boolean
`enable = mkOption`. Do not report them. R4's actionable list is short (2 G1 +
1 G2); that is a finding, not a gap. If a walk agent proposes an idiom item not
in R4, it must clear G3 and G4 on its own evidence or be dropped.

## Acceptance
1. Every `.nix` file in the repo has a section. Missing files are the one
   failure mode that cannot be fixed later, because six tasks read this and
   none of them will notice the absence.
2. Every *overloaded* verdict names a destination.
3. Every idiom finding cites file:line and a replacement site.
4. No edits outside `docs/repo-hygiene/LEDGER.md`.
5. Verdicts are distributed. If nearly everything comes back *coherent*, the
   walk was too polite; if nearly everything is *overloaded*, it was applying a
   line-count heuristic that rubric B explicitly rejects. Either pattern is a
   reason to re-run a sample with a sharper prompt before publishing.
