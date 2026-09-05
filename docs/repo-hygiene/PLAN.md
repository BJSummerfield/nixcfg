# Repo hygiene plan

Strictly sequential. Rubric in RUBRIC.md, evidence in FINDINGS.md, loop in
PROCESS.md, live status in STATE.json.

## Research bundles (run once, before T1; results cached in tasks/)
- **R1 — nix lint & fmt in CI.** statix/deadnix/nixfmt: which checks are worth
  enabling on a repo this size, how to wire them as flake `checks` vs a CI
  step, which statix lints are noise. Feeds T1.
- **R4 — nix idiom currency.** What changed in nixpkgs / home-manager /
  sops-nix idiom over roughly the last two years that a config written across
  that span would not have picked up: option helpers, deprecated types,
  freeform `settings` modules, library functions that replace hand-rolled
  wrappers, systemd hardening defaults. Produces a **checklist the walk can
  apply mechanically**, each item with a citation. Feeds TW and T13.

Cut on 2026-09-04 review: R2 (comment/doc conventions — rubric A already *is*
the policy; researching community norms could only agree with it or relitigate
it) and R3 (module layout — its only real consumer is T9, so it runs as T9's
own research step; T10's aggregator question does not need a bundle).

## Tasks

### Tier 1 — enforcement, then look before touching anything
- **T1 — Lint and format gate.** Add statix + deadnix + `nixfmt --check` as
  flake checks and to the devShell; fix everything they flag. The fix-everything
  reformat commit goes in .git-blame-ignore-revs — it is the largest blame-noise
  commit of the whole effort. `invariant: none`
  — the drvPath baseline for every later task is recorded at the end of T1.
  Scope: flake.nix, .github/workflows/check.yml, .git-blame-ignore-revs,
  whatever the linters flag.

- **TW — The walk.** Read-only, repo-wide, fanned out in parallel: one cheap
  agent per module directory, each handed RUBRIC.md and the R4 checklist. For
  every `.nix` file it reports, in at most a dozen lines:
    1. **Purpose** — the file's reason to exist in one sentence, no "and".
    2. **Does** — what it actually does, enumerated, each entry with why it is
       here. Verdict: *coherent* / *table* / *overloaded* (+ what should move
       out, and where to).
    3. **Comments** — count of comments that fail rubric A, by category
       (restatement / history / design prose), and the few that clearly earn
       their place.
    4. **Idiom** — anything from the R4 checklist, plus any place this repo
       solves one problem two ways. Cited per G4, filtered by G3 — worth doing,
       not merely newer.
    5. **Namespace** — for each option the file declares: which of
       `mine.system.*` / `mine.user.*` would a reader predict it lives in, and
       was the prediction right? One line per miss. (This absorbs what was T11.)
    6. **Confidence**, and anything it could not judge.
  Output is `LEDGER.md`, one section per file, plus a cross-file idiom summary
  (the G1 findings only show up when you look across modules) and a namespace
  summary for GATE 2. No edits.
  This is the single survey every later task reads instead of re-deriving.
  `invariant: drvPath` (trivially — nothing changes).

### Tier 2 — orientation and dead weight (cheap, cannot conflict)
- **T2 — Root README + New_Host relocation.** Write README.md: what the repo
  is, host table, build/deploy commands, secret rotation, how to add a host.
  Move New_Host.md -> docs/new-host.md, trim against the README, link both
  ways. `invariant: drvPath`.
- **T3 — Docs triage.** **DECIDED: delete `docs/superpowers/` and
  `docs/local-llm-review-2026-09-01/` outright**, and drop `/.superpowers/`
  from .gitignore. Git history is the archive. The reviewer confirms nothing
  remaining links to a deleted path and no operational fact lived only there.
  `invariant: drvPath`.

### Tier 3 — naming and wiring (rewrites import paths; before any content edit)
- **T4 — Directory naming normalization.** `_1password` -> `onepassword`,
  `polkit_kde` -> `polkit-kde`, `encode_queue` -> `encode-queue`. Rename dirs,
  update every import and any option path echoing the old spelling, add the
  commit to .git-blame-ignore-revs if it lands as a bulk move.
  Plus the option rename **`mine.users.*` -> `mine.accounts.*`** (user decision
  2026-09-04): the system account registry, one keystroke from the unrelated
  `mine.user.*` home-manager namespace, where a typo silently defines an option
  nobody reads. 6 files, see STATE.json. Note the encode_queue trap: it is also
  a package attribute and a derivation pname, so renaming those would move a
  drvPath this task must hold fixed.
  `invariant: drvPath`.
- **T10 — Aggregator derivation.** Make modules/{nixos,home,darwin,
  home-darwin}.nix consistently ordered, or derived from the filesystem
  (`lib.filesystem.listFilesRecursive` vs. an alphabetized hand list — a
  two-sentence choice, no research bundle), so adding a module cannot be
  half-wired. `invariant: drvPath`.

### Tier 4 — the payload, all driven by LEDGER.md
- **T5 — Comment diet, worst offenders.** modules/devbox/plugins.nix (91%),
  modules/printing/nixos.nix (57%), modules/pi-coding-agent/settings.nix (50%),
  modules/pi-coding-agent/home.nix (46%). Delete by default per rubric A; keep
  only operational knowledge and load-bearing constraints. `invariant: drvPath`.
- **T6 — Comment diet, local-llm and devbox.** modules/local-llm/*.nix,
  modules/devbox/container.nix and nixos.nix. Extra care: several comments here
  encode live operational facts (MTP removal, vision propagation, KV
  behaviour). Those get relocated, not deleted. `invariant: drvPath`.
- **T13 — Idiom convergence.** Apply the ledger's idiom findings that clear the
  G3 bar, internal drift (G1) before external (G2). Batched by pattern, not by
  file, so one spelling changes everywhere at once. Anything recorded but not
  done is listed in the PR body with the reason. `invariant: drvPath` — an
  idiom change that alters the build is not an idiom change and gets its own
  discussion.
- **T8 — Host-file diet.** hosts/redtruck/default.nix (222 lines, ~30-line sops
  essay, six near-identical secret declarations), hosts/vps, hosts/t495. Push
  rationale into the devbox module; consider having that module generate its
  own sops.secrets from the devboxes attrset so a host declares only the
  sopsFile. `invariant: drvPath`.
- **T11 — folded into TW + GATE 2 (2026-09-04 review).** It already admitted it
  might be a documented no-op, yet was budgeted a full task cycle. TW collects
  the namespace-prediction evidence per file; GATE 2 presents it as a decision.
  If the ledger shows real incoherence, a rename task is spawned then; if not,
  the no-op is recorded in the GATE 2 note and the cycle is saved.

### GATE 2 — check in before restructuring
**DECIDED 2026-09-04:** after T8, stop. Present the ledger's responsibility
verdicts — which files are coherent, which are tables, which are genuinely
overloaded and what should move out of each — plus the namespace summary
(the old T11 question: rename, or documented no-op?), and get approval before
T7 or T9 touches anything.

### Tier 5 — responsibility work (highest risk; last, on a clean base)
- **T7 — Make the overloaded files do less.** Plus the **container address
  registry** (user decision 2026-09-04, see tasks/T7-ip-registry.md): eleven
  modules hardcode a 192.168.100.x pair with no registry and a uniqueness check
  that covers only devbox instances. Act only on files the ledger
  marked *overloaded*, and only by moving the foreign responsibility to where
  it belongs — never by cutting a coherent file at a line number.
  `invariant: drvPath`.
- **T9 — flake.nix.** Fails the one-sentence test: it generates host outputs,
  builds the check matrix, and defines packages. Runs its own research step
  (module layout at scale: options/config separation, derived aggregators,
  flake-parts — the old R3, scoped to its one real consumer) and extracts
  accordingly, evaluating flake-parts and rejecting it explicitly in the PR
  body if the dependency is not worth it. `invariant: drvPath` for host outputs; checks may change shape.
- **T12 — Final sweep.** Re-run the baseline survey, confirm the metrics moved,
  update README, confirm CI green. Then delete `docs/repo-hygiene/` — the plan
  is an artifact like any other and rubric D1 applies to it. Closing summary
  goes in the PR body.

## Order

**Amended 2026-09-04: T9 promoted from last to second, at user request.** The
check block is self-contained - it depends on neither the ledger nor the
comment diets - so the "restructure on a clean base" argument does not apply to
it, and every intervening task would otherwise pile onto a file that is already
45% machinery.
T1, T9, TW, T2, T3, T4, T10, T5, T6, T13, T8, GATE 2, T7, T12.

## Ordering rationale
T1 first so every later task is machine-verified. TW second because it is
read-only and its ledger is what T5/T6/T7/T8/T13 and GATE 2 all consume — one
survey, six consumers, instead of six agents re-reading the same files. T2/T3 are pure
addition and deletion and cannot conflict. T4 and T10 rewrite import paths, so
they land before content edits and the diet tasks never rebase across renames.
Tier 4 is the payload. T7 and T9 restructure and go last, on a base that is
already lint-clean, consistently named, comment-dieted, and free of dead docs —
by which point what each file is *for* is far easier to see than it is today.
