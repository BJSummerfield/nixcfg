{
  lib,
  config,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.agent-recipes;
  tools = pkgs.callPackage ./package.nix { };
  roles = import ../pi-coding-agent/settings.nix;

  recipes = [
    "research"
    "triage"
  ];

  skillsUnder =
    root:
    builtins.listToAttrs (
      map (
        name: lib.nameValuePair "${root}/${name}/SKILL.md" { source = ./. + "/${name}/SKILL.md"; }
      ) recipes
    );
in
{
  options.mine.user.agent-recipes = {
    enable = mkEnableOption "agent recipes for pi and Claude Code";
  };
  config = mkIf cfg.enable {
    home.packages = [ tools ];

    home.file = {
      ".pi/agent/recipes/research/workflow.js".source = ./research/workflow.js;
      ".pi/agent/recipes/sizing.json".source = ./sizing/sizing.json;
    }
    // skillsUnder ".pi/agent/skills"
    // skillsUnder ".claude-state/skills"
    // lib.mapAttrs' (
      name: text: lib.nameValuePair ".claude-state/agents/${name}.md" { inherit text; }
    ) roles.claudeAgentFiles;
  };
}
