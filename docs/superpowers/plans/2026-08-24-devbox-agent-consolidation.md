# Devbox Agent Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts ship no coding agents; devbox and workbox run pi and Claude on `mattpocock/skills` with no Superpowers and one shared environment contract.

**Architecture:** Delete two host-side modules and their dead wiring. Add one pinned, flattened skills derivation consumed by both agents. Replace pi-superagents' `modelTiers` with two `pi -p` wrapper scripts that carry model alias and thinking level directly. Generate Claude's `settings.json` from nix and inject the environment contract through the existing `mkAgent` wrapper.

**Tech Stack:** Nix flakes, NixOS `containers.*` (systemd-nspawn), home-manager, pi 0.84.2, Claude Code 2.1.234.

**Spec:** `docs/superpowers/specs/2026-08-24-devbox-agent-consolidation-design.md`

## Global Constraints

- **Never destroy a devbox container.** Only five paths are bind-mounted; `/home/agent/projects` and `/var/lib/paseo/worktrees` are not among them. Recreating a container destroys every clone and any uncommitted work.
- **Claude discovers skills exactly one level under its skills directory.** A nested tree yields zero skills with no error. Verified by probe.
- **Claude's `appendSystemPromptFile` settings key does nothing** on 2.1.234 — verified by probe, so injection must go through a CLI flag. Use `--append-system-prompt`: it is enumerated in `--help` and probe-verified end to end. (`--append-system-prompt-file` is also accepted by the CLI, but it is undocumented — absent from `--help`'s option list, mentioned only in prose — and unprobed, so it buys nothing here.)
- **`home.file` hard-fails on existing unmanaged paths** — the repo sets neither `backupFileExtension` nor `force`.
- Skills pin: rev `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`, hash `sha256-N5tpUIHO2VFeJntBTl6/VLDIVpqoshwFxNJlfXXUwsQ=`.
- Every task is verified with `nix build .#checks.x86_64-linux.<name>`; this repo has no runtime test suite. `nixos-t495` and `nixos-redtruck` are eval-only checks, `devboxes` is a pure-eval test of the devbox module.
- Run `nix fmt` before each commit; the repo uses nixfmt.

**Commit grouping:** five commits rather than the three originally sketched — the skills derivation (Task 2) is independently buildable, and separating the pi module cleanup from the devbox wiring keeps each `nix build` failure attributable to one file.

---

### Task 1: Remove host-side coding agents

Hosts stop shipping agents entirely. `modules/coding-agents/` spawned ephemeral per-session containers with no GitHub token; `modules/claude-code/` provided the `claude-host` escape hatch. Both go, along with three home-module imports that no host enables.

**Files:**
- Delete: `modules/coding-agents/container.nix`, `modules/coding-agents/nixos.nix`, `modules/coding-agents/options.nix`, `modules/coding-agents/launcher.sh`
- Delete: `modules/claude-code/home.nix`
- Modify: `modules/nixos.nix:22`
- Modify: `modules/home.nix` (three import lines)
- Modify: `hosts/t495/default.nix:30,62`
- Modify: `modules/users/nixos.nix:38`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task only removes. `modules/devbox/*` is untouched and keeps its own `mine.allowedUnfree = [ "claude-code" ]` at `container.nix:82`.

- [ ] **Step 1: Confirm the blast radius before deleting**

```bash
grep -rn "coding-agents\|claude-code" --include="*.nix" . | grep -v "^./modules/coding-agents/\|^./modules/devbox/\|^./docs/"
```

Expected: exactly five hits — `modules/nixos.nix:22`, `modules/home.nix` (the `./claude-code/home.nix` line), `hosts/t495/default.nix:30`, `hosts/t495/default.nix:62`, and the prose comment at `modules/users/nixos.nix:38`. If anything else appears, stop and report it.

- [ ] **Step 2: Delete both modules**

```bash
git rm -r modules/coding-agents modules/claude-code
```

- [ ] **Step 3: Drop the NixOS module import**

Remove this line from `modules/nixos.nix` (line 22):

```nix
    ./coding-agents/nixos.nix
```

- [ ] **Step 4: Drop three home-module imports**

Remove these three lines from `modules/home.nix`. `opencode` and `pi-coding-agent` are dead wiring — `modules/nixos.nix:42-44` applies `home.nix` to every host via `sharedModules`, but nothing outside devbox enables either, and devbox imports them directly at `devbox/container.nix:111-112`.

```nix
    ./claude-code/home.nix
    ./opencode/home.nix
    ./pi-coding-agent/home.nix
```

- [ ] **Step 5: Drop both t495 enables**

Remove from `hosts/t495/default.nix` line 30:

```nix
      coding-agents.enable = true;
```

and line 62:

```nix
        claude-code.enable = true;
```

Leave `paseo-desktop.enable = true` (line 91) alone — that is how t495 reaches devbox.

- [ ] **Step 6: Fix the now-stale comment**

In `modules/users/nixos.nix`, the `uid` option description ends with "which breaks anything keyed on numeric ownership, like the coding-agents bind mounts." Replace that trailing clause so it names a mechanism that still exists:

```nix
              Static uid, identical on every host. Without it NixOS
              allocates uids first-come per machine, so the same user can
              end up with different uids on different hosts - which breaks
              anything keyed on numeric ownership, like the devbox
              container's bind mounts.
```

- [ ] **Step 7: Verify t495 still evaluates**

```bash
nix build --no-link .#checks.x86_64-linux.nixos-t495
```

Expected: success. A failure naming `mine.system.coding-agents` or `mine.user.claude-code` means an enable was missed; a failure naming an import path means a delete was missed.

- [ ] **Step 8: Verify every other host and the devbox tests**

```bash
nix flake check
```

Expected: success. This covers all six hosts plus `devboxes` and `photoform`.

- [ ] **Step 9: Commit**

```bash
nix fmt
git add -A
git commit -m "refactor: remove host-side coding agents

Hosts run no agents now; all real work happens in the devbox and workbox
containers, which are the only place a GitHub token was ever wired up.
modules/coding-agents spawned ephemeral per-session containers with no
gh, no /run/secrets/github-token and no credential helper, so agents
there could not push at all.

Also drops the opencode and pi-coding-agent home imports: modules/nixos.nix
applies home.nix to every host via sharedModules, but nothing outside
devbox enabled either, and devbox imports both directly."
```

---

### Task 2: Pinned, flattened Pocock skills derivation

Upstream nests skills as `skills/<category>/<name>/SKILL.md`. Claude only discovers skills one level deep, so a nested tree gives it zero skills with no error. This derivation flattens the categories away and drops `deprecated` and `in-progress`.

**Files:**
- Create: `modules/devbox/skills.nix`

**Interfaces:**
- Consumes: `pkgs` only.
- Produces: `import ./skills.nix pkgs` → a store path whose direct children are skill directories, each containing `SKILL.md`. Tasks 4 uses this as a `home.file` source for both agents.

- [ ] **Step 1: Write the derivation**

Create `modules/devbox/skills.nix`:

```nix
# Matt Pocock's skill pack, pinned and flattened for agent discovery.
#
# Upstream nests skills as skills/<category>/<name>/SKILL.md. Claude only
# discovers skills exactly one level under its skills directory - a nested
# tree yields zero skills and no error, which is why this flattens rather
# than symlinking the upstream tree straight in. Pi would recurse either
# way; one shape keeps both agents reading the same directory.
#
# `deprecated` and `in-progress` are dropped deliberately: the first is
# upstream's own graveyard, the second is unfinished.
#
# Bump: change rev, set hash to lib.fakeHash, build, paste the real hash.
pkgs:
let
  src = pkgs.fetchFromGitHub {
    owner = "mattpocock";
    repo = "skills";
    rev = "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76";
    hash = "sha256-N5tpUIHO2VFeJntBTl6/VLDIVpqoshwFxNJlfXXUwsQ=";
  };
in
pkgs.runCommand "mattpocock-skills" { } ''
  mkdir -p $out
  for category in engineering productivity misc; do
    for skill in ${src}/skills/$category/*/; do
      [ -f "$skill/SKILL.md" ] || continue
      name=$(basename "$skill")
      # Flattening collapses three namespaces into one. A collision would
      # otherwise silently merge two skills' files together.
      if [ -e "$out/$name" ]; then
        echo "duplicate skill name across categories: $name" >&2
        exit 1
      fi
      cp -r "$skill" "$out/$name"
    done
  done
  chmod -R u+w $out
''
```

- [ ] **Step 2: Build it**

```bash
nix build --no-link --print-out-paths --impure --expr \
  'import ./modules/devbox/skills.nix (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux'
```

Expected: one store path printed. If the hash mismatches, the pin in Step 1 was transcribed wrong — do not "fix" it by pasting whatever nix reports without checking the rev matches.

- [ ] **Step 3: Assert the output shape**

```bash
p=$(nix build --no-link --print-out-paths --impure --expr \
  'import ./modules/devbox/skills.nix (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux')
echo "skills: $(ls "$p" | wc -l)"
echo "at depth 2: $(find "$p" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)"
echo "deeper (must be 0): $(find "$p" -mindepth 3 -name SKILL.md | wc -l)"
ls "$p" | grep -cE '^(triage|to-tickets|code-review)$'
```

Expected: `skills: 29`, `at depth 2: 29`, `deeper (must be 0): 0`, and `3` for the last line. A non-zero "deeper" count means flattening failed and Claude would see nothing.

- [ ] **Step 4: Commit**

```bash
nix fmt
git add modules/devbox/skills.nix
git commit -m "feat(devbox): pin and flatten the Pocock skill pack

Upstream nests skills under category directories. Claude discovers skills
exactly one level below its skills dir - verified by probe - so a nested
tree would install 29 skills and surface none of them, with no error to
read. Flattening here keeps both agents on one shape.

deprecated and in-progress are dropped."
```

---

### Task 3: Strip Superpowers and superagents from the pi module

pi keeps only `pi-web-access`. The `superagents` config block and its `modelTiers` lose their consumer, and the activation that seeded `~/.pi/agent/extensions/subagent/config.json` goes with them.

**Files:**
- Modify: `modules/pi-coding-agent/settings.nix`
- Modify: `modules/pi-coding-agent/home.nix`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `import ./settings.nix` keeps exactly three attributes — `settings`, `models`, `webSearch`. The `superagents` attribute is gone; Task 4 must not reference it.

- [ ] **Step 1: Trim the package list**

In `modules/pi-coding-agent/settings.nix`, replace the `packages` list with:

```nix
    packages = [
      "npm:pi-web-access"
    ];
```

This drops `pi-token-speed` and `@monotykamary/pi-tps` (two tokens-per-second meters doing the same job), `git:github.com/obra/superpowers`, and `npm:@teelicht/pi-superagents`.

- [ ] **Step 2: Delete the superagents block**

Delete the entire `superagents = { ... };` attribute from `settings.nix`, including its comment block (the one beginning "pi-superagents tier config, seeded at"). Keep `webSearch` immediately after it.

- [ ] **Step 3: Delete the now-dead let bindings**

`budgetModel` existed only to pick the `cheap` tier's alias. It and its two helpers are now unreferenced. Delete these three bindings from the `let` block:

```nix
  defaultEntry = llm.models.${llm.default};
  defaultAliases = builtins.attrNames (defaultEntry.aliases or { });
  # Assumes at most one alias: with two, `head` picks the lexicographically
  # first, which is arbitrary - pick deliberately if a second is ever added.
  budgetModel = if defaultAliases == [ ] then llm.default else builtins.head defaultAliases;
```

Keep `qualified` — `webSearch.summaryModel` still uses it.

- [ ] **Step 4: Delete the superagents activation from home.nix**

In `modules/pi-coding-agent/home.nix`, delete the `superagentsConfig` binding from the `let` block:

```nix
  # Deliberately a bare store file rather than a home.file entry - see the
  # activation script below.
  superagentsConfig = pkgs.writeText "pi-superagents-config.json" (builtins.toJSON data.superagents);
```

and delete the whole `home.activation.piSuperagentsConfig` block together with the long comment above it (beginning "pi-superagents user config; merged over the package's bundled defaults").

- [ ] **Step 5: Confirm nothing still references the removed names**

```bash
grep -rn "superagents\|budgetModel\|defaultAliases\|pi-token-speed\|monotykamary" modules/
```

Expected: no output. Any hit is a missed deletion.

- [ ] **Step 6: Verify redtruck still evaluates**

```bash
nix build --no-link .#checks.x86_64-linux.nixos-redtruck && nix build --no-link .#checks.x86_64-linux.devboxes
```

Expected: both succeed. An "attribute 'superagents' missing" error means Step 4 was done without Step 2, or vice versa.

- [ ] **Step 7: Commit**

```bash
nix fmt
git add modules/pi-coding-agent/
git commit -m "refactor(pi): drop Superpowers, superagents and both TPS meters

pi-superagents goes with Superpowers rather than surviving it: its
subagent tool's own description says to use it only inside a Superpowers
workflow, its workflow parameter accepts only \"superpowers\", and its
allowed-agent list enumerates sp-* roles. Its sp-* entrypoints would hard
-fail anyway once the entry skills are gone.

pi-token-speed and @monotykamary/pi-tps are both tokens-per-second
trackers; there was never a reason to run two.

modelTiers loses its consumer here and comes back as pi-cheap/pi-max
wrappers in the devbox container."
```

---

### Task 4: Wire both agents in the devbox container

Seed the flattened skills for pi and Claude, generate Claude's `settings.json` with no plugins, and add the two fan-out wrappers that replace `modelTiers`.

**Files:**
- Modify: `modules/devbox/container.nix`

**Interfaces:**
- Consumes: `import ./skills.nix pkgs` from Task 2; `piWrapped` (already defined at `container.nix:20-27`).
- Produces: `pi-cheap` and `pi-max` on the container's PATH. Task 5's `ENVIRONMENT.md` documents them by name.

- [ ] **Step 1: Add the skills and tier wrappers to the `let` block**

In `modules/devbox/container.nix`, after the existing `piWrapped` binding, add:

```nix
  agentSkills = import ./skills.nix pkgs;

  # Fan-out tiers. These replace pi-superagents' modelTiers: pi's own CLI
  # takes provider/id:thinking, which is exactly what that config resolved.
  #
  # Strictly read-only - deliberately no `bash`, which is a write vector
  # regardless of the other tools (a child given bash creates files with
  # `echo >`). The parent does all git and gh work and hands children a
  # pre-materialised diff path.
  #
  # `-ns` because a child is given its instructions directly; it should not
  # pay for the whole skill-description block. Calls piWrapped rather than
  # the mkAgent `pi` on PATH so a child does not re-enter direnv, which the
  # parent has already loaded.
  mkTier =
    {
      name,
      model,
      thinking,
    }:
    pkgs.writeShellScriptBin name ''
      exec ${piWrapped}/bin/pi -p \
        --model ${model}:${thinking} \
        --tools read,grep,find,ls \
        --no-session -ns "$@"
    '';

  tierPkgs = [
    (mkTier {
      name = "pi-cheap";
      model = "redtruck/Qwen3.8-27B-NVFP4-48k";
      thinking = "medium";
    })
    (mkTier {
      name = "pi-max";
      model = "redtruck/Qwen3.8-27B-NVFP4";
      thinking = "xhigh";
    })
  ];

  # Claude keeps plugins and preferences in one small file. Generated with
  # enabledPlugins empty so a container never comes up with Superpowers on.
  # Auth lives separately in .credentials.json and is untouched.
  claudeSettings = pkgs.writeText "claude-settings.json" (
    builtins.toJSON {
      theme = "dark";
      inputNeededNotifEnabled = true;
      agentPushNotifEnabled = true;
      enabledPlugins = { };
    }
  );
```

- [ ] **Step 2: Put the tier wrappers on PATH**

In the `environment.systemPackages` block (around line 88), add `tierPkgs`:

```nix
  environment.systemPackages =
    agentPkgs
    ++ tierPkgs
    ++ [ ghWrapped ]
    ++ (with pkgs; [
      curl
      fd
      jq
      ripgrep
      git
      direnv
    ]);
```

- [ ] **Step 3: Seed skills for both agents**

In the home-manager `users.agent` block, beside the existing `home.file.".pi/agent/APPEND_SYSTEM.md"` line, add:

```nix
      # Both agents read the same flattened tree. Read-only store symlinks
      # are correct: neither writes skill files.
      home.file.".pi/agent/skills".source = agentSkills;
      home.file.".claude-state/skills".source = agentSkills;
```

- [ ] **Step 4: Add the tier wrappers to the user profile**

Change the existing `home.packages` line so children are on PATH for interactive shells too:

```nix
      home.packages = agentPkgs ++ tierPkgs;
```

- [ ] **Step 5: Generate Claude's settings.json**

Add to the same `users.agent` block. Copy rather than symlink for exactly the reason `pi-coding-agent/home.nix` documents: Claude rewrites this file, and writing through a store symlink fails with `EROFS`.

```nix
      # Copied, not linked: Claude rewrites settings.json (theme changes,
      # plugin toggles), and a store symlink would make that write fail
      # with EROFS. `rm` before `install` because install(1) follows an
      # existing symlink to its read-only target - and because the file
      # already exists unmanaged in every running container.
      home.activation.claudeSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        run mkdir -p $VERBOSE_ARG "$HOME/.claude-state"
        run rm -f $VERBOSE_ARG "$HOME/.claude-state/settings.json"
        run install $VERBOSE_ARG -m 0644 ${claudeSettings} \
          "$HOME/.claude-state/settings.json"
      '';
```

- [ ] **Step 6: Verify evaluation**

```bash
nix build --no-link .#checks.x86_64-linux.nixos-redtruck && nix build --no-link .#checks.x86_64-linux.devboxes
```

Expected: both succeed.

- [ ] **Step 7: Verify the wrappers are read-only and target the alias**

Do not build `system.build.toplevel` here — the eval checks above are the gate, and a full container build is slow and needs redtruck's substituters.

```bash
grep -n "Qwen3.8-27B-NVFP4-48k" modules/devbox/container.nix
grep -n "tools read,grep,find,ls" modules/devbox/container.nix
grep -c "bash" modules/devbox/container.nix
```

Expected: one hit for the alias, one for the `--tools` line, and the `--tools` line must not contain `bash`. The third count is non-zero for unrelated reasons (the file uses `writeShellScriptBin`); what matters is that `--tools` reads exactly `read,grep,find,ls`.

Then confirm the wrapper derivation builds on its own:

```bash
nix build --no-link --print-out-paths --impure --expr \
  'let p = (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux;
   in p.writeShellScriptBin "probe" "exec pi -p --model redtruck/Qwen3.8-27B-NVFP4-48k:medium --tools read,grep,find,ls --no-session -ns \"$@\""'
```

Expected: a store path. This only proves the shell wrapper is well-formed; the real invocation is acceptance item 4, which needs redtruck up.

- [ ] **Step 8: Commit**

```bash
nix fmt
git add modules/devbox/container.nix
git commit -m "feat(devbox): seed Pocock skills for both agents, add fan-out tiers

pi and Claude read the same flattened skills tree. Claude's settings.json
is generated with enabledPlugins empty so a container never starts with
Superpowers on; it is copied rather than symlinked because Claude
rewrites it and EROFS through the store is the failure that pattern
already exists to avoid.

pi-cheap and pi-max replace pi-superagents' modelTiers. Both are strictly
read-only: bash is a write vector regardless of the other tools, so the
parent does all git and gh work and hands children a diff path."
```

---

### Task 5: One environment contract, read by both agents

The current `APPEND_SYSTEM.md` tells devbox agents their filesystem is discarded at session end, which is false for a persistent container. It is also pi-only. Replace it with one file both agents read.

**Files:**
- Create: `modules/devbox/ENVIRONMENT.md`
- Delete: `modules/pi-coding-agent/APPEND_SYSTEM.md`
- Modify: `modules/devbox/agents.nix`
- Modify: `modules/devbox/container.nix`

**Interfaces:**
- Consumes: `pi-cheap` / `pi-max` from Task 4 (named in the prose).
- Produces: `mkAgent` gains an optional `args` parameter defaulting to `""`.

- [ ] **Step 1: Write the shared contract**

Create `modules/devbox/ENVIRONMENT.md`:

```markdown
# Environment: persistent devbox container

You are running inside a long-lived NixOS container (systemd-nspawn).
The container is the security boundary - there is no sandbox wrapping
your commands, so tools behave normally.

- This container persists across sessions and across host reboots. Your
  home directory, your shell history and anything you install by hand
  are still here next time. Do not treat this as scratch space that
  cleans itself up.
- Projects live in `/home/agent/projects` and paseo worktrees in
  `/var/lib/paseo/worktrees`. Neither is bind-mounted from the host:
  they exist only inside this container, so uncommitted work is not
  backed up by anything. Push anything you care about.
- Every project's devShell is pre-built by the `devbox-warm` service, so
  `direnv exec .` is fast. Agents are launched through a wrapper that
  loads the project devShell first; if a toolchain binary is missing,
  the `.envrc` is probably untrusted rather than the tool absent.
- Missing tools: prefer `nix shell nixpkgs#<pkg>` or `nix-shell -p <pkg>`
  - the store is shared with the host, so anything it already has costs
  no download. npm/pip/cargo also work. There is no sudo and you will
  never need it.
- Git push, pull and clone authenticate through a credential helper that
  reads a GitHub PAT at use time. `gh` is separate: a wrapper exports
  `GH_TOKEN` from the same secret. The token is scoped to specific
  repositories, so an auth or permission failure usually means the repo
  is out of scope - report it rather than retrying.
- You have unrestricted network access.

## Delegating work (pi only)

Two wrappers spawn a child pi with a fixed model and thinking level:

- `pi-cheap "<task>"` - smaller declared context window, medium thinking.
  Use this for fan-out.
- `pi-max "<task>"` - full window, maximum thinking. Use for a single
  hard review or debugging pass.

A child is a separate process, so its context never enters yours - only
what it prints comes back. Both are strictly read-only: they have no
`bash`, so a child cannot run `git`, `gh`, or write files. Do that work
yourself and hand the child what it needs. For a diff, redirect it to a
file and pass the path (`git diff <base> > /tmp/review.patch`); the
redirect prints nothing, so you spend no context on a diff you never read.

Run several at once with `&` and `wait`. Keep it to two or three: they
all share one inference server, so a wider fan-out queues rather than
going faster.
```

- [ ] **Step 2: Delete the stale file**

```bash
git rm modules/pi-coding-agent/APPEND_SYSTEM.md
```

- [ ] **Step 3: Give `mkAgent` an optional `args` parameter**

`real` is interpolated into two `exec` lines — the direnv-failure path and the normal path — so appending flags must happen in both. Replace the body of `modules/devbox/agents.nix`:

```nix
# Agent launchers for the devbox container.
# Paseo spawns agents as child processes, not login shells, so direnv never fires.
# Use `direnv exec .` to load the project devShell before running the agent.
# Fails open if .envrc is blocked (untrusted); warns on flake eval errors.
{ pkgs, lib }:
{
  mkAgent =
    {
      name,
      real,
      # Extra flags appended to every invocation, before the caller's own.
      # Interpolated into both exec paths below - the fail-open one and the
      # normal one - so an agent cannot lose them by having an untrusted
      # .envrc.
      args ? "",
    }:
    pkgs.writeShellScriptBin name ''
      err=$(${lib.getExe pkgs.direnv} exec . true 2>&1 >/dev/null); rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "WARNING: .envrc found but not allowed (blocked/untrusted) for this directory or its parents:" >&2
        printf '%s\n' "$err" >&2
        echo "WARNING: running without a project devShell - toolchain binaries such as cargo will be missing." >&2
        exec ${real} ${args} "$@"
      fi
      if printf '%s' "$err" | grep -q '^error:'; then
        echo "WARNING: the project devShell may have failed to build:" >&2
        printf '%s\n' "$err" >&2
      fi
      exec ${lib.getExe pkgs.direnv} exec . ${real} ${args} "$@"
    '';
}
```

- [ ] **Step 4: Point both agents at the contract**

In `modules/devbox/container.nix`, add a binding for the file and pass it to Claude. Claude has no equivalent of pi's `APPEND_SYSTEM.md`, and its `appendSystemPromptFile` settings key does nothing on 2.1.234 — only the CLI flag works.

```nix
  envContract = ./ENVIRONMENT.md;
```

Then change the `claude` entry in `agentPkgs`:

```nix
    (mkAgent {
      name = "claude";
      real = lib.getExe pkgs.claude-code;
      # Claude reads no equivalent of pi's APPEND_SYSTEM.md, and the
      # appendSystemPromptFile settings key is inert on 2.1.234 - the CLI
      # flag is the only mechanism that works.
      args = ''--append-system-prompt "$(cat ${envContract})"'';
    })
```

- [ ] **Step 5: Repoint pi at the new file**

Change the existing line in the home-manager block:

```nix
      home.file.".pi/agent/APPEND_SYSTEM.md".source = envContract;
```

- [ ] **Step 6: Confirm nothing still references the deleted file**

```bash
grep -rn "APPEND_SYSTEM" --include="*.nix" .
```

Expected: exactly one hit — the `home.file.".pi/agent/APPEND_SYSTEM.md".source = envContract;` line in `modules/devbox/container.nix`. That is the destination filename pi requires, not the source.

- [ ] **Step 7: Verify evaluation and the generated launcher**

```bash
nix build --no-link .#checks.x86_64-linux.nixos-redtruck && nix build --no-link .#checks.x86_64-linux.devboxes
```

Expected: both succeed.

Then confirm the flag reaches **both** exec paths by building just the launcher, not the whole system:

```bash
p=$(nix build --no-link --print-out-paths --impure --expr \
  'let f = builtins.getFlake (toString ./.);
       pkgs = f.inputs.nixpkgs.legacyPackages.x86_64-linux;
       a = import ./modules/devbox/agents.nix { inherit pkgs; inherit (pkgs) lib; };
   in a.mkAgent { name = "probe"; real = "/bin/echo"; args = "--append-system-prompt X"; }')
grep -c -- "--append-system-prompt" "$p/bin/probe"
```

Expected: `2` — one per exec path. A `1` means only one branch got the flag, so an agent launched in a directory with an untrusted `.envrc` would silently lose its environment contract.

- [ ] **Step 8: Commit**

```bash
nix fmt
git add -A
git commit -m "feat(devbox): one environment contract, read by pi and Claude

The old APPEND_SYSTEM.md told devbox agents their filesystem is discarded
when the session ends. That was true of the ephemeral coding-agents
container and false here - devbox containers are persistent, and neither
projects nor paseo worktrees are bind-mounted, so uncommitted work has no
backing store. Agents were being told the opposite.

Claude now reads the same file. Its appendSystemPromptFile settings key
is inert on 2.1.234, so mkAgent grows an args parameter and passes the
CLI flag on both exec paths."
```

---

## Pre-deploy: clear the two skills directories

Run this **before** `nixos-rebuild switch`, once per box, inside the container. This is not optional housekeeping: home-manager's `checkLinkTargets` runs *during* activation, and `home.file` hard-fails on an unmanaged path in the way (this repo sets neither `backupFileExtension` nor `force`). If either path exists as a real directory, activation aborts and **nothing** from this change lands — no skills, no generated `settings.json`.

```bash
# Remove these two only if they exist as real directories left by a previous
# manual install - a symlink into the nix store is this config's own and is
# replaced normally.
rm -rf ~/.pi/agent/skills ~/.claude-state/skills
```

Skipping this step fails safely: activation stops with a clobber error, nothing is lost and nothing is half-applied. Remove the two directories and re-run `nixos-rebuild switch`.

---

## Post-merge: manual cleanup

Nix adds files; it never removes the ~70M of state these changes orphan. Run once per box, inside the container, after the rebuild lands. Do **not** recreate the container — `/home/agent/projects` and `/var/lib/paseo/worktrees` are not bind-mounted and would be destroyed.

```bash
rm -rf ~/.pi/agent/npm/node_modules/@weiping \
       ~/.pi/agent/npm/node_modules/@teelicht \
       ~/.pi/agent/npm/node_modules/@monotykamary \
       ~/.pi/agent/npm/node_modules/pi-token-speed
rm -rf ~/.pi/agent/git/github.com/obra
rm -rf ~/.pi/agent/extensions/subagent
rm -rf ~/.claude-state/plugins
```

Claude then needs re-authenticating on devbox; workbox has never been logged in.

## Post-merge: acceptance

1. `pi` starts; its `<available_skills>` lists Pocock skills and no Superpowers skill, and no `subagent` tool is offered.
2. `claude` starts; `/skills` lists the same set and `enabledPlugins` is empty.
3. Both agents describe a *persistent* container when asked about their environment.
4. `pi-cheap "read /etc/hostname and reply with only its contents"` returns. Two in parallel with `&` + `wait` both return.
5. `gh issue list` and `git push` still work.
6. On t495: no `claude`, `pi`, or `opencode` binary on PATH; `paseo-desktop` still reaches devbox.

Item 4 is the one that cannot be checked until redtruck is back — the wrapper model ids are confirmed present in pi's registry but have never been run.
