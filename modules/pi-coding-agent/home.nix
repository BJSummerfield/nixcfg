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

  # pi-subagents 0.78.0 has no process-group kill when a run ends on its deadline
  # or a stop, so a timed-out subagent could orphan its detached bash tool tree
  # and keep mutating the shared worktree (scene_gen #153). Use the build-time
  # patched local package until upstream lands group-kill termination: then
  # re-pin "npm:pi-subagents@<version>" in modules/devbox/plugins.nix, remove
  # this wiring and the pi-subagents-group-kill check, and clean the stale npm
  # copy with: pi remove npm:pi-subagents
  piSubagents = pkgs.callPackage ./pi-subagents-patched.nix { };

  settings = data.settings // {
    packages = data.settings.packages ++ [ (toString piSubagents) ];
    subagents = data.settings.subagents // {
      defaultSubagentOnlyExtensions = [
        "${config.home.homeDirectory}/.pi/agent/subagent-extensions/budget-valve.js"
        "${config.home.homeDirectory}/.pi/agent/subagent-extensions/save-page.js"
      ];
    };
  };
  piSettings = pkgs.writeText "pi-settings.json" (builtins.toJSON settings);

in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };
  config = mkIf cfg.enable {
    # Keep the patched package in the container store: the settings.json
    # reference is plain text and would not pull the path into the closure.
    home.packages = [ piSubagents ];

    home.file = {
      ".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;
      ".pi/agent/extensions/subagent/config.json".text = builtins.toJSON data.subagentConfig;
      ".pi/agent/subagent-extensions/budget-valve.js".source = ./extensions/budget-valve.js;
      ".pi/agent/subagent-extensions/save-page.js".source = ./extensions/save-page.js;
      ".pi/agent/extensions/resume-card.js".source = ./extensions/resume-card.js;
      ".pi/agent/AGENTS.md".text =
        builtins.replaceStrings [ "@subagentModel@" ] [ data.settings.subagents.defaultModel ]
          (builtins.readFile ../devbox/writing.md + "\n" + builtins.readFile ./AGENTS.md);
    }
    // lib.mapAttrs' (
      name: text: lib.nameValuePair ".pi/agent/agents/${name}.md" { inherit text; }
    ) data.agentFiles;

    home.activation.piSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run mkdir -p $VERBOSE_ARG "$HOME/.pi/agent"
      run rm -f $VERBOSE_ARG "$HOME/.pi/agent/settings.json"
      run install $VERBOSE_ARG -m 0644 ${piSettings} "$HOME/.pi/agent/settings.json"
    '';

    programs.pi-coding-agent = {
      enable = true;
      extraPackages = import ./extra-packages.nix pkgs;
      settings = { };
      inherit (data) models;
    };
  };
}
