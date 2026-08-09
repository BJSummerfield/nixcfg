# Comment Style: Blunt Reasons Only

## Problem

~234 comment lines across `modules/` are verbose, narrative, and cross-referential.
Comments tell stories ("they did, and pi died at startup with..."), reference past
commits, explain Nix primitives, and force the reader to jump between comments to
understand context.

## Goal

Every comment states the reason in one sentence. Nothing else.

## Principles

1. **State the reason.** One sentence. Lead with the conclusion.
2. **No history.** No "this happened before so we do X" — just "X because Y."
3. **No cross-references.** No "same as above" or "see the uid comment." Each comment stands alone.
4. **No explaining Nix.** Assume the reader knows flakes, modules, containers, derivations.
5. **Delete if self-evident.** If the code already says it, the comment is noise.
6. **Keep security rationale and bring-up instructions.** Format them as clean one-liners or step lists.

## Scope

- **Files:** All `.nix` files under `modules/` (~234 comment lines)
- **Changes:** Comments only. No code changes, no behavior changes.
- **Out of scope:** `flake.nix`, `hosts/`, `users/`, `secrets/`, `.sops.yaml`, `New_Host.md`

## Approach

Single pass over every `.nix` file in `modules/`:
1. Read each file
2. Rewrite verbose comments to blunt one-liners
3. Leave already-good comments alone
4. Delete self-evident comments

## Examples

### Before (devbox/container.nix — piWrapped)
```
# pi installs and loads its declared packages at startup, so it needs node
# *and* bun on PATH no matter which project devShell it ends up inside - a
# project whose flake lacks them would otherwise break pi's plugins. Upstream's
# home-manager module does this wrapping via extraPackages; we redo it here
# because we set that module's package to null below, and a null package makes
# the module drop extraPackages silently. Importing the same list it uses is
# what keeps the two from drifting: they did, and pi died at startup with
# `Error: spawn bun ENOENT` for it.
```

### After
```
# Wrap pi with node+bun on PATH so plugins work regardless of project devShell.
# Redo upstream's extraPackages wrapping since we null the package below.
```

### Before (devbox/container.nix — uid)
```
# Pinned deliberately, and NOT to a host uid. These containers run with
# PRIVATE_USERS=no and the host's nix-daemon socket bind-mounted, so the
# container's uid IS a host uid to the daemon - and every uid in
# mine.users with isSuperUser lands in nix's trusted-users, which is
# root-equivalent (a trusted client can set extra-sandbox-paths and bind
# the host's ssh/sops/signing keys into a build). 1500 is outside the
# host's 1000-1003 range, so the daemon treats the agent as untrusted:
# it can still build, substitute and realise derivations - everything
# nix-direnv needs - but cannot override trusted settings.
```

### After
```
# uid 1500: outside host range (1000-1003) so nix-daemon treats it as
# untrusted — can build/realise but cannot override trusted settings.
```

## Success Criteria

- Comment count reduced (target: ~30-50% reduction, but quality over metric)
- No comment is longer than 3 lines unless it's a bring-up instruction block
- No comment references another comment or a past event
- A reader can understand any block of code from its own comments alone