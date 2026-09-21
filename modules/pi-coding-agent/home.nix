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

  settings = data.settings // {
    subagents = data.settings.subagents // {
      defaultSubagentOnlyExtensions = [
        "${config.home.homeDirectory}/.pi/agent/subagent-extensions/budget-valve.js"
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
    home.file.".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;

    home.file.".pi/agent/subagent-extensions/budget-valve.js".source = ./extensions/budget-valve.js;

    home.file.".pi/agent/AGENTS.md".source = pkgs.replaceVars ./AGENTS.md {
      imageBudget = toString data.imageBudget;
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
