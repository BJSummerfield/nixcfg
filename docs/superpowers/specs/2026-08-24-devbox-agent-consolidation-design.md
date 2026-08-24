# Devbox agent consolidation: hosts lose agents, Pocock's skills replace Superpowers

## Problem

Four unrelated-looking issues share one root: agent configuration is spread
across two container models and two agents, and only half of it is declarative.

**Hosts still run their own agent containers.** `mine.system.coding-agents`
spawns an ephemeral per-session container for pi/opencode/claude, and t495 is
its only consumer (`hosts/t495/default.nix:30`). That container has no
`gh`, no `/run/secrets/github-token`, and no git credential helper —
`github-token` appears only under `modules/devbox/*` and `hosts/redtruck`. So
agents there cannot push, let alone use a GitHub-backed workflow. Meanwhile
all real work happens on the devbox and workbox instances, which have the full
token wiring.

**Superpowers is being replaced by `mattpocock/skills` for a trial**, and the
two are not meant to be mixed. On pi, Superpowers arrives as a package; on
Claude it arrives as a plugin recorded in an unmanaged `settings.json`.
Removing it therefore takes two different mechanisms, only one of which nix
currently touches.

**`APPEND_SYSTEM.md` tells devbox agents something false.** It states "this
entire filesystem, including your home directory, is discarded when the session
ends". That is true of the coding-agents container and false of devbox, which
`modules/devbox/nixos.nix:1` calls "Persistent coding-agent containers" — and
the file is installed in both (`devbox/container.nix:139`,
`coding-agents/container.nix:87`). It is also pi-only; Claude reads no
equivalent, so it has never been told how its environment works.

**Two plugins do the same job.** `pi-token-speed` ("measure tokens per second
via sliding window") and `@monotykamary/pi-tps` ("Tokens-per-second tracker for
pi") are both TPS meters. Pi has no native readout to replace them, but it does
not need two.

## Goal

Hosts ship no coding agents at all. devbox and workbox run pi and Claude, both
loading `mattpocock/skills` from one pinned source, both reading one accurate
description of their environment, with no Superpowers on either. pi keeps
per-tier model and thinking-level selection for fan-out without an extension to
provide it.

## Decisions

**Hosts get no agents, not even an escape hatch.** `modules/coding-agents/` and
`modules/claude-code/` are both deleted. The `claude-host` wrapper existed for
work that must touch the machine itself; that work can be done without an agent.
This also removes dead wiring: `modules/home.nix` imports `opencode/home.nix`
and `pi-coding-agent/home.nix` for every host, but nothing outside devbox
enables either — devbox imports them directly in its own home-manager block
(`devbox/container.nix:111-112`). devbox declares its own
`mine.allowedUnfree = [ "claude-code" ]` at `container.nix:82`, so deleting the
host module does not break it.

**One pinned skills source, consumed by both agents.** A new
`modules/devbox/skills.nix` returns `pkgs.fetchFromGitHub` for
`mattpocock/skills`, pinned by rev and hash. It lives under `devbox/` rather
than `pi-coding-agent/` because Claude consumes it too. It is deliberately not
a flake input: none of the importers pass `extraSpecialArgs`, so `inputs` is
unreachable from the home-manager modules, and plumbing it through three blocks
costs more than a rev bump. Both agents get read-only store symlinks, which is
correct because neither writes skill files — pi's `core/skills.js` only
readdirs, stats and reads them.

devbox and workbox are two instances of the same module
(`hosts/redtruck/default.nix:104-118`), so this is one change covering both.

**pi-superagents goes with Superpowers.** Its bundled roles reference
Superpowers skills by name, its `subagent` tool's own description says "use this
tool only inside a Superpowers workflow", its `workflow` parameter accepts only
`"superpowers"`, and its allowed-agent list enumerates `sp-*` roles. Keeping it
while trialling a different skillset would be the same mixing one layer down.
Without it, `/sp-implement`, `/sp-plan` and `/sp-brainstorm` would hard-fail
anyway: "For root Superpowers entry-skill flows, missing required entry or
entrypoint lifecycle skills block prompt dispatch."

**Fan-out moves from `modelTiers` to `pi -p` wrappers.** Pi's own CLI takes
`--model provider/id:thinking`, which is exactly what `superagents.modelTiers`
was resolving. Two wrappers replace it:

    pi-cheap  → pi -p --model redtruck/Qwen3.8-27B-NVFP4-48k:medium \
                      --tools read,grep,find,ls --no-session -ns "$@"
    pi-max    → pi -p --model redtruck/Qwen3.8-27B-NVFP4:xhigh \
                      --tools read,grep,find,ls --no-session -ns "$@"

The `-48k` alias keeps doing its KV job, a child is a separate process so its
context never enters the parent's window, and `-ns` keeps children from paying
for the whole skill-description block.

**Children are strictly read-only; the parent does all git and gh work.**
There is no toolset that includes `bash` and still prevents writes — a child
given `bash` created a file with `echo >`. Pi's own help agrees: its read-only
example is `--tools read,grep,find,ls`, without `bash`. This fits how Pocock's
`code-review` already works, since it passes sub-agents "the path or fetched
contents of the spec" and the smell baseline "pasted in full (the sub-agent has
no other access to it)". The one deviation is the diff: rather than passing a
diff *command* for the child to run, the parent materialises it
(`git diff … > /tmp/rev.patch`) and passes the path. That is strictly better
here, because the redirect produces no stdout and so costs the parent no
context for a diff it never reads.

**Claude's config becomes declarative.** `.claude-state/settings.json` is 165
bytes of theme, notification preferences and `enabledPlugins`; auth lives
separately in `.credentials.json`, so generating it from nix risks nothing of
value. It needs the copy-not-symlink activation treatment that
`pi-coding-agent/home.nix` already documents, because Claude rewrites the file
and a store symlink would fail with `EROFS`.

**One environment contract, injected per agent.** A new
`modules/devbox/ENVIRONMENT.md` becomes the single source of truth. pi reads it
as `.pi/agent/APPEND_SYSTEM.md` exactly as today; Claude receives it via
`--append-system-prompt` in the `mkAgent` wrapper that already wraps it.
`modules/pi-coding-agent/APPEND_SYSTEM.md` is deleted.

The wrapper is the only mechanism that works. Claude's help text mentions an
`--append-system-prompt-file` form, and `appendSystemPromptFile` exists as a
string in the bundle, but neither is real in 2.1.234: the flag is not in the
enumerated CLI options, and setting the key in `settings.json` was probed
directly and had no effect, while the `--append-system-prompt` flag carried a
codeword through on the same version. Do not reach for the settings key.

`mkAgent` takes `{ name, real }` and interpolates `real` into **two** `exec`
lines (`devbox/agents.nix`), one for the direnv-failure path and one for the
normal path. Injection therefore either extends `mkAgent` with an optional
`args` parameter — preferred, since it keeps `real` a bare executable — or
embeds the flag in the `real` string, which works but silently applies to both
paths and is easy to misread later.

**Devbox-specific seeding lives in `devbox/container.nix`.** The skills
`home.file` entries for both agents go there, alongside the existing
`APPEND_SYSTEM.md` entry, rather than in `pi-coding-agent/home.nix`. That keeps
the pi module generic — it is imported by whatever wants pi, and a path into
`modules/devbox/` from inside it would invert the dependency. `home.nix` then
only *loses* the superagents activation block and gains nothing.

**Cleanup is manual and targeted, not a container rebuild.** Only five paths
are bind-mounted into a devbox container (`devbox/nixos.nix:234-261`):
`/dev/net/tun`, `/var/lib/tailscale-<name>`, and the three secrets. Neither
`/home/agent/projects` nor `/var/lib/paseo/worktrees` is among them, so
recreating a container would destroy every clone and any uncommitted work in
it. Targeted `rm` is both safer and cheaper.

## Change inventory

| # | Change | Files |
|---|---|---|
| 1 | Delete the coding-agents module | `modules/coding-agents/{container,nixos,options}.nix`, `launcher.sh` |
| 2 | Delete the host claude module | `modules/claude-code/home.nix` |
| 3 | Drop module import | `modules/nixos.nix:22` |
| 4 | Drop three home imports | `modules/home.nix` (`claude-code`, `opencode`, `pi-coding-agent`) |
| 5 | Drop both enables | `hosts/t495/default.nix:30,62` |
| 6 | Fix stale comment | `modules/users/nixos.nix:38` |
| 7 | Pinned skills source | new `modules/devbox/skills.nix` |
| 8 | Shared env contract | new `modules/devbox/ENVIRONMENT.md`; delete `modules/pi-coding-agent/APPEND_SYSTEM.md` |
| 9 | Drop the superagents activation block | `modules/pi-coding-agent/home.nix` |
| 10 | Trim packages; delete `superagents`/`modelTiers` | `modules/pi-coding-agent/settings.nix` |
| 11 | Add `pi-cheap` / `pi-max` | `modules/pi-coding-agent/extra-packages.nix` |
| 12 | Seed both agents' skills + Claude settings.json; inject env via `mkAgent` | `modules/devbox/container.nix`, `modules/devbox/agents.nix` |

Warming needs no change: `devbox-warm` already covers
`/home/agent/projects/*/` and paseo's `worktrees/<projectHash>/<slug>/`,
ordered after `home-manager-agent.service`, with tmpfiles pre-creating both
directories. It also makes fan-out cheap, since pi's wrapper runs
`direnv exec .` on every invocation.

## Verified facts

| Claim | Evidence |
|---|---|
| pi loads user skills from `~/.pi/agent/skills/` | `dist/core/skills.js:330-334`; `CONFIG_DIR_NAME = ".pi"` |
| Claude loads user skills from `$CLAUDE_CONFIG_DIR/skills/` | marker skills planted in both candidates; only `marker-statedir` was discovered |
| Nested `pi -p` works as a subagent | ran against jason; parsed tier flags, ran git via bash, returned only its answer, exit 0 |
| `--tools …,bash` is not read-only | child wrote `/tmp/should-not-exist.txt` via `echo >` |
| Read-only child + pre-materialised diff works | `git diff > /tmp/rev.patch`, child with `--tools read` answered correctly |
| Parallel fan-out works | two children on jason and robin, `&` + `wait`, 7.9s wall clock, both correct |
| `-ns` works | child answered correctly with skills discovery disabled |
| `redtruck/Qwen3.8-27B-NVFP4-48k` is a valid model id | `pi --list-models`: 49.2K context, 8.2K max tokens |
| PAT has Issues read **and** write on nixcfg | `gh label list` succeeded; probe label created and deleted, rc=0 both |
| Repo has none of the five triage state labels | `gh label list` shows only GitHub's 8 stock labels |
| git and gh authenticate independently | git via `~/.config/git/config` credential helper; gh via `GH_TOKEN` in the `ghWrapped` script |
| home-manager will hard-fail on clobber | no `backupFileExtension` or `force` anywhere in the repo |
| `--append-system-prompt` reaches Claude | probe file with a codeword; `claude -p` returned it |
| `appendSystemPromptFile` in settings.json does **not** | same codeword via the settings key; `claude -p` returned `NONE` |
| Claude's auth is container-local | `~/.claude-state/.credentials.json` |
| `/home/agent/projects` is **not** bind-mounted | `devbox/nixos.nix` has exactly five `hostPath` entries, none of them projects or worktrees |

The fan-out mechanism was exercised against jason and robin because redtruck
was offline for reconfiguration. The redtruck model ids in the wrappers are
confirmed present in pi's model registry but have not been run end to end;
step 6 of the verification below is what closes that gap.

## Manual cleanup runbook

Run once per box, in the container, after the rebuild lands. Nothing here is
recreated by nix, and none of it is load-bearing.

    # pi: extensions dropped from the packages list
    rm -rf ~/.pi/agent/npm/node_modules/@weiping \
           ~/.pi/agent/npm/node_modules/@teelicht \
           ~/.pi/agent/npm/node_modules/@monotykamary \
           ~/.pi/agent/npm/node_modules/pi-token-speed
    rm -rf ~/.pi/agent/git/github.com/obra
    rm -rf ~/.pi/agent/extensions/subagent

    # claude: plugin cache and install records
    rm -rf ~/.claude-state/plugins

Claude must then be re-authenticated on devbox; workbox has never been logged
in. Both are expected.

## Verification

1. `nix build` both devbox instances.
2. Boot; confirm `~/.pi/agent/skills/*/SKILL.md` and
   `~/.claude-state/skills/*/SKILL.md` resolve through their symlinks.
3. In pi: confirm the `<available_skills>` block lists Pocock's skills and no
   Superpowers skill, and that no `subagent` tool is offered.
4. In Claude: confirm the same skills are listed and `enabledPlugins` is empty.
5. Confirm both agents' system prompts describe a *persistent* container.
6. `pi-cheap "…"` returns from a fan-out; two in parallel complete.
7. `gh issue list` still works; `git push` still works.
8. Confirm t495 builds with no agent binaries present.

## Out of scope

- **t495 GitHub access.** Its containers never had a token; once it runs no
  agents this is moot. If host-level agent work is ever wanted again, it needs
  a sops-provisioned token, a bind mount, the credential helper and `ghWrapped`.
- **Per-repo tracker setup.** `/setup-matt-pocock-skills` writes
  `docs/agents/issue-tracker.md`, `triage-labels.md` and `domain.md` into each
  project. That is per-repo state on a bind-mounted tree, not machine config.
  The five triage state labels do not exist yet and will be created on first
  `/triage`.
- **opencode gets no environment contract.** devbox still ships it
  (`container.nix:118`), and it reads neither `ENVIRONMENT.md` nor any
  equivalent — as is true today. Wiring it up, or dropping it from devbox, is a
  separate decision.
- **`docs/superpowers/` naming.** The directory outlives the tool it is named
  after. Renaming it is a separate, purely cosmetic change.
