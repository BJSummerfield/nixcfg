{
  lib,
  config,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.mine.user.agent-recipes;
  tools = pkgs.callPackage ./package.nix { };
  defaults = import ./roles.nix;

  home = config.home.homeDirectory;
  recipesDir = "${home}/.pi/agent/recipes";

  mergedRoles = lib.recursiveUpdate (lib.mapAttrs (
    name: role:
    if role ? claude then
      role
      // {
        claude = role.claude // {
          model = cfg.claude.models.${name} or role.claude.model;
        };
      }
    else
      role
  ) defaults.roles) cfg.roles;

  resolvedRoles = lib.mapAttrs (name: role: {
    inherit (role)
      tools
      thinking
      output
      budget
      ;
    claude = role.claude // {
      agent = name;
    };
    acceptance = role.acceptance or null;
    harness = role.harness or null;
  }) mergedRoles;

  runnerConfig = {
    model = "${cfg.pi.provider}/${cfg.pi.model}";
    extensions = [
      "${home}/.pi/agent/subagent-extensions/budget-valve.js"
      "${home}/.pi/agent/subagent-extensions/save-page.js"
    ];
    inherit (cfg)
      worktreeDir
      stateDir
      concurrency
      inFlightTokens
      ;
    sizing = "${recipesDir}/sizing.json";
    roles = lib.mapAttrs (
      name: role: role // { prompt = "${recipesDir}/prompts/${name}.md"; }
    ) resolvedRoles;
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

  claudeAgentFiles = builtins.listToAttrs (
    builtins.concatMap (
      name:
      if mergedRoles.${name} ? claude then
        [
          {
            inherit name;
            value = defaults.claudeAgentFile name mergedRoles.${name};
          }
        ]
      else
        [ ]
    ) (builtins.attrNames mergedRoles)
  );

  roleAssertions = lib.concatLists (
    lib.mapAttrsToList (
      name: role:
      let
        inherit (role) budget;
      in
      [
        {
          assertion = budget.tokens + budget.reserve <= cfg.window - cfg.compactionReserve;
          message = "agent-recipes role ${name}: budget tokens ${toString budget.tokens} plus reserve ${toString budget.reserve} must not exceed window ${toString cfg.window} minus compaction reserve ${toString cfg.compactionReserve}";
        }
      ]
      ++ lib.optional (role.thinking == "xhigh") {
        assertion = budget.reserve >= cfg.maxTokens;
        message = "agent-recipes role ${name}: xhigh reserve ${toString budget.reserve} must be at least maxTokens ${toString cfg.maxTokens}";
      }
    ) resolvedRoles
  );

  claudeModelAssertions = lib.mapAttrsToList (name: _: {
    assertion = defaults.roles ? ${name};
    message = "agent-recipes: claude.models.${name} names a role that is not in the role table";
  }) cfg.claude.models;
in
{
  options.mine.user.agent-recipes = {
    enable = mkEnableOption "agent recipes for pi and Claude Code";

    pi.provider = mkOption {
      type = types.str;
      description = "Provider of the model the pi children run on";
    };
    pi.model = mkOption {
      type = types.str;
      description = "Model id the pi children run on, qualified by pi.provider";
    };
    window = mkOption {
      type = types.int;
      description = "Context window of the model the pi children run on, in tokens";
    };
    compactionReserve = mkOption {
      type = types.int;
      description = "Tokens the model keeps free for compaction";
    };
    maxTokens = mkOption {
      type = types.int;
      description = "Maximum reply size of the model the pi children run on, in tokens";
    };
    claude.models = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Per-role override of claude.model in the default role table";
    };
    roles = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      description = "Per-role overrides merged over the default role table";
    };
    worktreeDir = mkOption {
      type = types.str;
      default = "/var/tmp/pi-worktrees";
      description = "Where the runner checks out one worktree per task";
    };
    stateDir = mkOption {
      type = types.str;
      default = "/var/tmp/recipe-runner";
      description = "Where the runner keeps its state";
    };
    concurrency = mkOption {
      type = types.int;
      default = 3;
      description = "Number of helpers the runner runs at once";
    };
    inFlightTokens = mkOption {
      type = types.nullOr types.int;
      default = null;
      description = "Token cap on work in flight, or null for none";
    };
    resolved = mkOption {
      internal = true;
      readOnly = true;
      type = types.attrs;
      description = "Role table and model limits as written to roles.json, before prompt paths are added";
    };
    package = mkOption {
      type = types.package;
      readOnly = true;
      description = "The recipe tools package";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ tools ];

    mine.user.agent-recipes.package = tools;

    assertions = roleAssertions ++ claudeModelAssertions;

    mine.user.agent-recipes.resolved = {
      roles = resolvedRoles;
      inherit (cfg) window compactionReserve maxTokens;
    };

    home.file = {
      ".pi/agent/recipes/roles.json".text = builtins.toJSON runnerConfig;
      ".pi/agent/extensions/recipe-tools.js".source = ./extension/recipe-tools.js;
      ".pi/agent/recipes/sizing.json".source = ./sizing/sizing.json;
      ".pi/agent/subagent-extensions/budget-valve.js".source = ./extensions/budget-valve.js;
      ".pi/agent/subagent-extensions/save-page.js".source = ./extensions/save-page.js;
    }
    // lib.mapAttrs' (
      name: _:
      lib.nameValuePair ".pi/agent/recipes/prompts/${name}.md" {
        text = defaults.prompt "pi" name;
      }
    ) mergedRoles
    // skillsUnder ".pi/agent/skills"
    // skillsUnder ".claude-state/skills"
    // lib.mapAttrs' (
      name: text: lib.nameValuePair ".claude-state/agents/${name}.md" { inherit text; }
    ) claudeAgentFiles;
  };
}
