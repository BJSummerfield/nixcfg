# What "well organized" means for this repo

The standard each task is reviewed against. Ordered by how far this repo
currently sits from it.

## A. Comments: fewer, and only of two kinds

Default is **delete**. A comment survives only by being one of these:

**Keep — operational knowledge you cannot get back.** How to join a tailnet
from inside a NixOS container. Why a service needs a specific uid because
`owner` takes a host username. A vendor quirk that will bite the next reader.
Test: would someone re-derive this in under ten minutes with the man page open?
If no, keep it — but trim it to the fact.

**Keep — a load-bearing constraint on nearby code.** "Wrapped here because the
upstream module is disabled below." Short, specific, adjacent.

**Cut — everything else.** In particular:
- A1. Restating the code. `# enable printing` above `enable = true;`.
- A2. History. "An earlier version used ensurePrinters instead; it ran during
      boot before WiFi associated, so it failed every time." That is a commit
      message. Git has it.
- A3. Justifying a choice nobody is going to challenge.
- A4. Anything a CI check could assert instead. Make it the check.
- A5. Prose that explains a design rather than a line. If it needs a paragraph,
      it needs a doc with a title and a date, or it needs to not exist.

Ratios are a smell detector, not a limit: a file above ~30% comment lines is
worth looking at, and is usually a design doc wearing a `.nix` extension. But
the judgement is always per-comment against the two keep-tests above — a file
is never "done" because it hit a number.

When in doubt on a cut, the reviewer asks: does deleting this cost anyone
anything they cannot recover from `git log`, the module's own options, or the
upstream docs? If not, it goes.

## B. A file has one reason to exist

Size is not the test. A 300-line file that does one thing is fine. A 60-line
file doing three unrelated things is not.

The test is a **responsibility audit**: walk the file top to bottom, name each
thing it does and why that thing is here. Then read the list back.

- B1. If the list has one entry, or several entries that are obviously facets of
      one job, the file is fine at any length.
- B2. If an entry does not follow from the file's name and stated purpose, that
      entry is the problem — not the line count.
- B3. If two entries would change for different reasons, or on different
      schedules, or at the hands of different people, they want different files.
- B4. If the list is long but every entry is the same *kind* of thing (thirty
      helix language definitions, five hosts), the file is a table. Tables are
      allowed to be long.
- B5. Every file should be able to state its reason to exist in one sentence
      without using "and". If the sentence needs an "and", audit it.

When a file fails: the fix is to make it do less, not to cut it in half at an
arbitrary line. Move the foreign responsibility to where it belongs, or give it
its own file named after what it actually is.

B6. Large modules separate `options` from `config` — those are two
    responsibilities (interface and implementation), not one long one.
B7. Package/derivation definitions live in `package.nix`, not inline.
B8. Host files declare *policy* — which options, which values. Implementation,
    repetition, and rationale belong in the module the host is enabling. A host
    file that explains *how* something works has taken on a module's job.

## C. Structure is discoverable without reading it all
C1. A root README: what this is, which hosts exist, how to build, deploy, add a
    host, rotate a secret.
C2. One naming convention for directories and files — kebab-case — **except
    where the name is inherited from upstream.** A directory named after a
    nixpkgs attribute or an upstream project keeps that spelling; renaming it
    makes it *less* predictable, not more. Decided 2026-09-04 after checking
    each case:
    - `polkit_kde` **is** a defect and T4 renames it: its own option is already
      `mine.user.polkit-kde`, its unit is `polkit-kde-agent`, its package is
      `polkit-kde-agent-1`. The directory is the only underscore in sight.
    - `_1password` **stays**: it mirrors `pkgs._1password-cli` /
      `pkgs._1password-gui`, which nixpkgs spells that way because a Nix
      identifier cannot begin with a digit.
    - `encode_queue` **stays**: it is the upstream project's own name
      (`github.com/BJSummerfield/encode_queue`), and is also the `pname`,
      `mainProgram`, flake package attribute and `pkg-encode_queue` check name.
C3. Import aggregators consistently ordered, ideally derived rather than
    hand-maintained, so adding a module cannot be half-done.
C4. The option namespace is coherent: a reader can predict whether a knob is
    `mine.system.*` or `mine.user.*` without grepping.
C5. Docs live under `docs/`, not at the repo root.

## D. No dangling artifacts
D1. No plan or spec describing work that was reverted or superseded.
D2. Every doc states what it is and when it was true.
D3. Raw data dumps are kept only if something still references them.
D4. Tool-scratch directories are gitignored, not committed.
D5. This directory is itself an artifact. It is deleted by T12.

## E. Correctness is enforced, not remembered
E1. `nix fmt --check`, `statix`, `deadnix` run in CI.
E2. `nix flake check` covers every host and every flake package (already true).
E3. Cleanup changes prove they changed nothing: identical
    `system.build.toplevel.drvPath` for all hosts before and after.

## F. Reproducibility (already strong — hold the line)
F1. Flake inputs dedupe transitive nixpkgs onto ours.
F2. Secret declaration follows one uniform shape per host.

## G. Idiom currency — one way to do a thing, and it is the current way

This config has grown for a year. Both nixpkgs and this repo's own conventions
moved during that time, so the oldest modules encode the best way to do
something *as of when they were written*. That is drift, and it is invisible
until someone looks for it deliberately.

Two kinds, and they are not equally important:

**G1. Internal drift — the one that matters most.** Three modules solving the
same problem three different ways is worse than all three using a merely
adequate pattern. The newest module is usually the reference: it was written
with the most knowledge. When the walk finds N spellings of one idea, the
finding is "converge on the newest," not "pick a favourite."

**G2. External drift.** Patterns nixpkgs/home-manager have since superseded:
options that grew a first-class helper, deprecated type names, hand-rolled
wrappers that a library function now does, `settings`-style freeform config
replacing hand-built files, service definitions that predate a module gaining
real options.

**G3. Note, do not chase.** A pattern that is merely older is not a defect.
The bar for changing working code is that the new spelling is *shorter, harder
to get wrong, or removes a hand-rolled thing that upstream now owns*. "More
modern" alone is not a reason. Anything failing that bar gets recorded and
dropped, not implemented.

**G4. Every idiom finding names its evidence.** A file and line where the old
spelling lives, the replacement, and where the replacement is already used in
this repo or documented upstream. A finding that cannot cite is a guess.
