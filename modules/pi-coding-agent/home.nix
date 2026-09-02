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

  # Seed only. The live file is whatever the harness has appended since.
  lessonsSeed = pkgs.writeText "pi-lessons.md" ''
    # Lessons

    Durable, falsifiable things a later session would act on differently.
    Append when you finish a task; prune when this file starts costing more
    context than it saves.
  '';
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

    # pi's global context file: loadProjectContextFiles reads agentDir before it
    # walks the cwd's ancestors, so this lands in <project_context> for the
    # dispatching session only. Children are gated on `inheritGlobalContext`,
    # which is unset in every bundled agent definition - so this file is
    # orchestrator-facing by construction, and anything a child must obey has to
    # live in the repo's own AGENTS.md instead. Dispatch policy goes here rather
    # than in devbox/ENVIRONMENT.md, which is the environment contract and stays
    # free of workflow.
    #
    # A store symlink is fine only while pi *reads* this file: a harness that
    # edited it would replace the link, and the next reconfigure would fail
    # activation on checkLinkTargets, taking every other home.file with it -
    # models.json included. That is why what the harness learns goes to the
    # seeded LESSONS.md below instead.
    #
    # Generated, not copied: @imageBudget@ comes from the same catalog block that
    # builds --limit-mm-per-prompt, so the number the agent is told and the
    # number the engine enforces cannot drift. replaceVars fails the build on an
    # unsubstituted placeholder, which is the property worth having.
    home.file.".pi/agent/AGENTS.md".source = pkgs.replaceVars ./AGENTS.md {
      imageBudget = toString data.imageBudget;
    };

    # The writable half of the context split: AGENTS.md is policy nix owns,
    # LESSONS.md is what the harness learns and must be able to append to.
    # Seeded once and never overwritten - a rebuild must not discard it, and it
    # cannot be a home.file for the checkLinkTargets reason above.
    home.activation.piLessons = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run mkdir -p $VERBOSE_ARG "$HOME/.pi/agent"
      if [ ! -e "$HOME/.pi/agent/LESSONS.md" ]; then
        run install $VERBOSE_ARG -m 0644 ${lessonsSeed} "$HOME/.pi/agent/LESSONS.md"
      fi
    '';

    # ~/.pi/agent/settings.json - seeded package membership and subagent model
    # routing. Copied, not linked: pi rewrites this file on `pi install` /
    # `pi update --extensions`, and that write dies with EROFS through a store
    # symlink - silently, since pi swallows the failure and prints "Installed".
    # The seeded specs carry no versions, so a rebuild re-asserts *which*
    # plugins without pinning *which version*, and a live update survives it.
    # models.json stays a store symlink because pi treats it as input-only.
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
