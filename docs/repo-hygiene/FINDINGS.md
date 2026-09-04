# Baseline survey — 2026-09-04, branch unique-turtle @ 1b12ba9

Repo: 129 .nix, 16 .md, 9291 nix lines, 1246 nix comment lines (13.4%).

## Comment hot spots (comment lines / total)
| file | ratio |
|---|---|
| modules/devbox/plugins.nix | 64/70 = 91% |
| modules/printing/nixos.nix | 21/37 = 57% |
| modules/pi-coding-agent/settings.nix | 109/218 = 50% |
| modules/pi-coding-agent/home.nix | 45/97 = 46% |
| modules/devbox/container.nix | 141/345 = 41% |
| modules/local-llm/models.nix | 103/261 = 39% |
| modules/local-llm/nixos.nix | 94/268 = 35% |
| modules/caddy/nixos.nix | 39/147 = 27% |
| modules/local-llm/vllm-service.nix | 36/136 = 26% |
| .github/workflows/check.yml | ~40% |

## Files worth a responsibility audit
Line count is only the sampling heuristic here — long is not the defect, doing
too much is. These are the files large enough that "what is this file for?" is
not answerable at a glance, so T7 audits them:

container.nix 345, stalwart-server 295, tests/devboxes 279, devbox/nixos 272,
local-llm/nixos 268, local-llm/models 261, tests/photoform 258, dns-server 251,
immich-server 224, hosts/redtruck 222, pi-coding-agent/settings 218,
firefox/home 206, filesystems/nas 201, flake.nix 201, vikunja 197,
jellyfin-server 189, photoform/nixos 180, system/nixos 177.

Some will pass: local-llm/models.nix and the helix language set are tables, and
rubric B4 says tables may be long. flake.nix visibly fails B5 — it generates
host outputs, builds the check matrix, and defines packages.

## Structure
- No root README.md. No root CLAUDE.md/AGENTS.md.
- New_Host.md (341 lines) sits at the repo root.
- Naming: `_1password`, `polkit_kde`, `encode_queue` vs kebab-case elsewhere.
- modules/{nixos,home,darwin,home-darwin}.nix are hand-maintained import lists;
  nixos.nix is not alphabetized (`./devbox/nixos.nix` sits after `./openssh`).
- hosts/redtruck/default.nix carries a ~30-line sops rationale block and six
  near-identical secret declarations that the devbox module could generate.
- Option namespace: `mine.system.*` holds genuinely per-machine policy
  (hostName, nvidia) alongside things that are not system-ish
  (printing, devboxes, teamspeak-client). `mine.user.*` for home-manager.

## Dangling artifacts
- docs/superpowers/ — 6 files, 2666 lines, from a tool no longer in use
  (superpowers was removed from both agents in PR #145). Two of the three plans
  describe the caddy-l4 / stalwart-cert work that was merged and then reverted.
- docs/local-llm-review-2026-09-01/ — 7 files incl. two raw data dumps
  (.tsv, .txt). Point-in-time; later PRs (#154/#155) already corrected claims
  in it. No status header anywhere saying which parts are now false.
- .gitignore lists /.claude/ and /.superpowers/ — the latter is dead weight.

## Enforcement gaps
- CI runs `nix flake check` only. No `nix fmt --check`, no statix, no deadnix.
- devShell ships nixfmt + sops; no linters.
