# T7 addition — central container address registry

**User decision, 2026-09-04.** Folded into T7 (the responsibility task) because
address allocation is a cross-cutting concern that no module owns today.

`invariant: drvPath` — **keep every current address exactly as it is.** This is
a move of *where the numbers are declared*, not a renumbering. If a drvPath
moves, an address changed and that is a bug.

## The problem
Eleven modules each hardcode a `192.168.100.x` host/local pair:

| module | host/local | | module | host/local |
|---|---|---|---|---|
| jellyfin-server | .10/.11 | | local-llm | .24/.25 |
| teamspeak-server | .12/.13 | | devbox (default) | .26/.27 |
| dns-server | .14/.15 | | redtruck workbox | .28/.29 |
| immich-server | .20/.21 | | terraria-server | .30/.31 |
| vikunja-server | .22/.23 | | stalwart-server | .40/.41 |
| photoform | .50/.51 | | | |

`hosts/redtruck/default.nix:110-119` also sets devbox/workbox pairs directly.

There is no registry, so adding a container means grepping eleven files to find
a free number. `modules/devbox/nixos.nix:199` asserts uniqueness **only among
devbox instances** — nothing checks across modules. Its own comment names the
failure mode: *"A duplicate address produces a container that starts cleanly and
then cannot route, which reads as a NAT problem rather than a config one."* That
is a good guard covering one module out of eleven.

## The job
1. One place that owns the allocation — an attrset mapping container name to its
   pair. Modules read from it instead of literal strings.
2. **Every address keeps its current value.** Prove it with the invariant.
3. Generalise devbox's assertion: uniqueness across *every* container address on
   a host, not just devboxes. Keep its comment — it explains why the check
   exists better than a new one would.
4. Decide where the registry lives and justify it. It is host-independent data,
   so it is a table (rubric B4). It should not live in a module that also does
   something else.
5. `hosts/redtruck/default.nix` should stop repeating the devbox/workbox pairs
   if the registry can supply them — that overlaps T8's "hosts declare policy,
   not implementation" (rubric B8), so coordinate rather than duplicate.

## Acceptance
- drvPath loop byte-identical to `docs/repo-hygiene/DRVPATH-BASELINE.txt`.
  Non-negotiable — the numbers do not change.
- The generalised assertion actually fires: temporarily duplicate an address,
  confirm eval fails with a useful message, revert.
- `grep -rn '192\.168\.100\.' --include='*.nix'` afterwards: literals appear in
  the registry, not scattered through modules. Report any that must stay and why
  (e.g. a comment citing an address, or a test asserting one).
- `nix flake check` green.
