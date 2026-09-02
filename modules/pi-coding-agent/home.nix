{
  lib,
  config,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.pi-coding-agent;
  data = import ./settings.nix;

  # Seeded copy of ~/.pi/agent/settings.json (pi's package registry) -
  # written by the activation below, not by the home-manager module; see
  # the programs block and the piSettings activation for why.
  piSettings = pkgs.writeText "pi-settings.json" (builtins.toJSON data.settings);
in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };
  config = mkIf cfg.enable {
    # pi-web-access provider config (keyless); seeded declaratively so a
    # freshly built container comes up with search already configured
    # instead of needing a manual first-run setup.
    home.file.".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;

    # pi's global context file: loadProjectContextFiles reads agentDir before
    # it walks the cwd's ancestors, so this lands in <project_context> for the
    # dispatching session. It does NOT reach children, which is the opposite of
    # what this comment used to claim. Two different flags are in play and only
    # one is set: the bundled agents declare `inheritProjectContext: true`,
    # which keeps *repository* context, while the operator's global file is
    # gated on `inheritGlobalContext` - `?? false` in pi-subagents'
    # runtime-agent-registry, and unset in all twelve bundled definitions. So
    # AGENTS.md is orchestrator-facing by construction, which suits dispatch
    # policy (the parent decides how to size a child; the child does not need
    # the table) but rules it out for anything a child must obey. That has to
    # live in the repo's own AGENTS.md, the one channel every child inherits.
    #
    # APPEND_SYSTEM.md is a second channel and reaches most of them, contrary
    # to what this comment said before: pi-args.ts:812 spends --system-prompt
    # on a `replace` agent's body and --append-system-prompt on an `append`
    # one, while resource-loader.js discovers the global append file only
    # `if (!appendSources)`. So `replace` agents - eleven of the bundled twelve
    # - leave the append slot free and do get devbox/ENVIRONMENT.md; only
    # `delegate` spends the slot and misses it. See the fuller note at
    # devbox/container.nix:19.
    #
    # Dispatch policy goes here rather than in devbox/ENVIRONMENT.md, which is
    # the environment contract and stays free of workflow.
    #
    # A store symlink is fine only while pi *reads* this file. A harness told to
    # evolve its own instructions will replace it with a real file, and then the
    # next reconfigure fails activation on checkLinkTargets - taking every other
    # home.file with it, models.json included. ENVIRONMENT.md tells agents to
    # keep durable instructions in the repo for that reason.
    # Generated, not copied: @imageBudget@ comes from the same catalog block
    # that builds --limit-mm-per-prompt, so the number the agent is told and
    # the number the engine enforces cannot drift apart. replaceVars fails the
    # build on an unsubstituted placeholder, which is the property worth having
    # - a silently un-expanded "@imageBudget@" in a system prompt would be worse
    # than no guidance at all.
    home.file.".pi/agent/AGENTS.md".source = pkgs.replaceVars ./AGENTS.md {
      imageBudget = toString data.imageBudget;
    };

    # ~/.pi/agent/settings.json - the seeded package membership and the
    # subagent model routing. Copied, not linked: pi's own package manager
    # rewrites this file
    # on `pi install` / `pi remove` / `pi update --extensions`, and that
    # write dies with EROFS through a store symlink - worse than the
    # extension-config case, because pi swallows the failure (exit 0,
    # "Installed" printed, nothing recorded, and the package does not load
    # on the next start). The seeded specs carry no
    # versions (plugins.nix declares membership only), so the rebuild's
    # overwrite re-asserts *which* plugins without pinning *which version*
    # - a live `pi update --extensions` or `pi install ...@<ref>` floats
    # the installed versions and persists across rebuilds. An interim pin
    # against a bad release is the one-line version/ref addition to
    # plugins.nix. models.json stays a store symlink because pi treats it
    # as input-only.
    home.activation.piSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run mkdir -p $VERBOSE_ARG "$HOME/.pi/agent"
      run rm -f $VERBOSE_ARG "$HOME/.pi/agent/settings.json"
      run install $VERBOSE_ARG -m 0644 ${piSettings} "$HOME/.pi/agent/settings.json"
    '';

    programs.pi-coding-agent = {
      enable = true;
      # shared with modules/devbox/container.nix, which wraps pi by hand -
      # see the header of extra-packages.nix
      extraPackages = import ./extra-packages.nix pkgs;
      # settings = {} on purpose: the upstream home-manager module would
      # otherwise write ~/.pi/agent/settings.json as a store symlink (its
      # write is mkIf (settings != {}), so an empty attrset opts out
      # cleanly). pi needs that file writable - the piSettings activation
      # above seeds it from this same data.settings.
      settings = { };
      models = data.models;
    };
  };
}
