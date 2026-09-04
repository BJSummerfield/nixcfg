# Execution process

State lives in docs/repo-hygiene/: RUBRIC.md, FINDINGS.md,
PLAN.md, STATE.json, tasks/T##.md, tasks/T##-review-N.md.
Resume by reading STATE.json and continuing at the first task not `done`.

## Per-task loop
For task T##:
1. **Research** (sonnet, read-only) — only if the task's `research` field is
   non-empty and the shared research bundle does not already answer it.
   Output: <=30 lines of recommendation into tasks/T##-research.md.
2. **Implement** (sonnet, own git worktree off `main`, branch `hygiene/T##`)
   — reads tasks/T##.md and RUBRIC.md, edits only files listed in `scope`.
   Must leave `nix flake check` green and, for cleanup tasks, prove the
   drvPath invariant (below). Output: <=20 lines: what changed, invariant
   result, anything it chose not to do.
3. **Review** — two tiers, matched to where the risk actually is:
   - **Mechanical tasks (T2, T4, T10):** the drvPath invariant has already done
     the judging — a rename or reorder producing byte-identical drvPaths has
     nothing left to adversarially review. Sonnet checks the short residue
     (README accuracy, no dangling old path in docs, scope respected) against
     a checklist. No opus.
   - **Judgment tasks (T1, T3, T5, T6, T8, T13, T7, T9):** adversarial review
     (opus, fresh context, read-only, own worktree) — gets tasks/T##.md
     acceptance criteria + the diff, NOT the implementer's summary. Judges
     against the rubric and the criteria. Explicitly checks for out-of-scope
     edits and for rationale that was deleted but should have been preserved
     somewhere. Output: verdict PASS/FAIL + numbered findings.
4. **Fix** (sonnet, same worktree) then **re-review** (same tier as step 3,
   fresh). Cap at 2 fix rounds. If round 2 still FAILs, stop and surface to
   the user.
5. Orchestrator opens one PR per task, merges, then the next task's worktree
   branches off the new main. Sequential — no two tasks in flight.

## The invariant that makes review cheap
Comments, renames, file splits, and doc deletions must not change what gets
built. This must cover *every* build output the flake defines — nixos, darwin,
and packages — or edits under modules/darwin*, modules/home-darwin*, or the
package files sail through unverified. Before and after:

    for h in elitebook redtruck t495 paynefield vps; do
      nix eval --raw ".#nixosConfigurations.$h.config.system.build.toplevel.drvPath"; echo
    done
    for h in $(nix eval --json '.#darwinConfigurations' --apply builtins.attrNames | jq -r '.[]'); do
      nix eval --raw ".#darwinConfigurations.$h.extendModules" --apply \
        'f: (f { modules = [ ({ lib, ... }: { system.configurationRevision = lib.mkForce null; }) ]; }).config.system.build.toplevel.drvPath'
      echo
    done
    for s in $(nix eval --json '.#packages' --apply builtins.attrNames | jq -r '.[]'); do
      for p in $(nix eval --json ".#packages.$s" --apply builtins.attrNames | jq -r '.[]'); do
        nix eval --raw ".#packages.$s.$p.drvPath"; echo
      done
    done

Every task marked `invariant: drvPath` must produce byte-identical output.
A task that legitimately changes the build (T1 CI, T9 flake split) is marked
`invariant: none` and needs the reviewer to reason about behaviour instead.

## Models
- opus: adversarial review of judgment tasks only (see step 3), and the T3
  docs-triage judgement call.
- sonnet: research, implementation, mechanical fixes, checklist review of
  mechanical tasks.
- haiku: pure counting/grepping sweeps.
- no fable.

## Token discipline
- Subagents return structured summaries, never file dumps or full diffs.
- The orchestrator does not read diffs; it reads verdicts.
- Research is bundled by theme up front (see PLAN.md "Research bundles"), so
  most tasks skip step 1 entirely.
- Each task file states its scope so no subagent has to survey the repo again.

### Why the darwin leg forces `system.configurationRevision`
`modules/system/darwin.nix:5` sets it from `inputs.self.rev`, so the darwin
toplevel drvPath is a function of the commit hash and changes on *every*
commit regardless of content. Compared naively it can never be byte-identical
across a task, which is worse than not checking it: the reviewer learns to wave
the darwin diff away, and a real darwin regression gets waved away with it.
Forcing the revision to null removes the commit hash and leaves the leg
sensitive to exactly what it is supposed to catch. No nixos host sets this
option, so the nixos leg needs no such treatment.
