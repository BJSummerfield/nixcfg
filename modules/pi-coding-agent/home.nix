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

  subagentConfigText =
    homePackages: homeFileKeys:
    assert lib.assertMsg
      (lib.strings.hasSuffix ".pi/agent/subagent-only/budget-valve.js" (
        lib.head settings.subagents.defaultSubagentOnlyExtensions
      ))
      "the budget valve must be installed under subagent-only/, which pi loads only in subagent sessions";
    assert lib.assertMsg (if cfg.enable then lib.elem piSubagents homePackages else true)
      "pi-subagents must stay in the agent's home.packages, the pi settings install the same store path";
    assert lib.assertMsg (lib.all (key: !lib.strings.hasPrefix ".pi/agent/skills/" key)
      homeFileKeys
    ) "pi skills are no longer installed for the recipe runner; the session has one way to dispatch";
    builtins.toJSON data.subagentConfig;

in
assert lib.assertMsg (data.subagentConfig.globalConcurrencyLimit == 3)
  "the subagent concurrency limit must stay at 3: the engine decodes four sequences and the parent session keeps one";
assert lib.assertMsg (
  data.recipes.window - data.recipes.compactionReserve - data.valve.handoffTokens == 32768
) "the valve must hand off 32768 tokens before the model's compaction point";
assert lib.assertMsg (
  agents.roles.reviewer.acceptanceRole == "read-only"
) "the reviewer must stay read-only: it runs the check and every reproduction itself";
assert lib.assertMsg (
  agents.roles.implementer.thinking == "medium"
) "the implementer must run with medium thinking";
{
  options.mine.user.pi-coding-agent = {
    enable = mkEnableOption "pi AI coding agent";
  };

  config = mkIf cfg.enable {
    home.packages = [ piSubagents ];

    home.file = {
      ".pi/agent/web-search.json".text = builtins.toJSON data.webSearch;
      ".pi/agent/extensions/subagent/config.json".text = subagentConfigText config.home.packages (
        lib.attrNames config.home.file
      );
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
