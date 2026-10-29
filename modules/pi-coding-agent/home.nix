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
  agents = import ./agents.nix;

  piSubagents = pkgs.callPackage ./pi-subagents-patched.nix { };

  settings = data.settings // {
    packages = data.settings.packages ++ [ (toString piSubagents) ];
    subagents = data.settings.subagents // {
      defaultSubagentOnlyExtensions = [
        "${config.home.homeDirectory}/.pi/agent/subagent-only/budget-valve.js"
      ];
    };
  };
  piSettings = pkgs.writeText "pi-settings.json" (builtins.toJSON settings);

  assertionsOk = lib.all (
    a:
    if lib.isAttrs a && a ? assertion then
      if a.assertion then true else throw (a.message or "assertion failed")
    else
      a
  ) config.assertions;
in
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };

  config = mkIf cfg.enable {
    assertions = [
      (lib.assertMsg (lib.all (key: !lib.strings.hasPrefix ".pi/agent/skills/" key) (
        lib.attrNames config.home.file
      )) "pi skills are no longer installed for the recipe runner; the session has one way to dispatch")
    ];

    home.packages = [ piSubagents ];

    home.file = {
      ".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;
      ".pi/agent/extensions/subagent/config.json".text =
        assert
          data.subagentConfig.maxActiveAsyncRunsPerSession == 3
          && data.subagentConfig."globalConcurrencyLimit" == 3
          && assertionsOk
          &&
            builtins.match ''key: !lib\.strings\.hasPrefix "\.pi/agent/skills/" key'' (
              builtins.readFile ./home.nix
            ) != null
          && builtins.match ''lib.attrNames config\.home\.file'' (builtins.readFile ./home.nix) != null;
        builtins.toJSON data.subagentConfig;
      ".pi/agent/extensions/resume-card.js".source = ./extensions/resume-card.js;
      ".pi/agent/AGENTS.md".text =
        builtins.readFile ../devbox/writing.md + "\n" + builtins.readFile ./AGENTS.md;
      ".pi/agent/subagent-only/budget-valve.js".source = ./extensions/budget-valve.js;
      ".pi/agent/subagent-only/budget-valve.json".text = builtins.toJSON data.valve;
    }
    // lib.mapAttrs' (
      name: text: lib.nameValuePair ".pi/agent/agents/${name}.md" { inherit text; }
    ) agents.agentFiles;

    mine.user.agent-recipes = {
      inherit (data.recipes) window compactionReserve maxTokens;
      pi = {
        inherit (data.recipes) provider model;
      };
    };

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
