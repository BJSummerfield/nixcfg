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

  home = config.home.homeDirectory;
  recipesDir = "${home}/.pi/agent/recipes";

  runnerConfig = {
    model = roles.runnerModel;
    extensions = [
      "${home}/.pi/agent/subagent-extensions/budget-valve.js"
      "${home}/.pi/agent/subagent-extensions/save-page.js"
    ];
    worktreeDir = "/var/tmp/pi-worktrees";
    stateDir = "/var/tmp/recipe-runner";
    concurrency = 3;
    inFlightTokens = null;
    sizing = "${recipesDir}/sizing.json";
    roles = lib.mapAttrs (
      name: role:
      role
      // {
        prompt = "${recipesDir}/prompts/${name}.md";
        claude = role.claude // {
          agent = name;
        };
      }
    ) roles.runnerRoles;
  };

  recipes = [
    "implement"
    "investigate"
    "plan"
    "research"
    "triage"
  ];

  skillsUnder =
    root:
    builtins.listToAttrs (
      map (
        name:
        lib.nameValuePair "${root}/${name}/SKILL.md" {
          text = builtins.readFile (./. + "/${name}/SKILL.md");
        }
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
      ".pi/agent/recipes/roles.json".text = builtins.toJSON runnerConfig;
      ".pi/agent/extensions/recipe-tools.js".source = ./extension/recipe-tools.js;
      ".pi/agent/recipes/sizing.json".source = ./sizing/sizing.json;
    }
    // lib.mapAttrs' (
      name: role: lib.nameValuePair ".pi/agent/recipes/prompts/${name}.md" { text = role.prompt; }
    ) roles.runnerRoles
    // skillsUnder ".pi/agent/skills"
    // skillsUnder ".claude-state/skills"
    // lib.mapAttrs' (
      name: text: lib.nameValuePair ".claude-state/agents/${name}.md" { inherit text; }
    ) roles.claudeAgentFiles;
  };
}
