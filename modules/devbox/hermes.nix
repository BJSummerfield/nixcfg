{
  inputs,
  tailnetHostname,
  agentProfiles ? true,
  agentPlugins ? true,
}:
{
  lib,
  pkgs,
  ...
}:
let
  llm = import ../local-llm/models.nix;
  model = llm.models.${llm.default};
  port = 9119;
  claudeConfigDir = "/home/agent/.claude-state";
  agentPaths = [
    "/home/agent"
    "/var/lib/paseo/worktrees"
  ];
  asAgent = {
    environment.HOME = lib.mkForce "/home/agent";
    serviceConfig.ReadWritePaths = agentPaths;
  };
in
{
  imports = [
    inputs.hermes-agent.nixosModules.default
    ./hermes-profiles.nix
    ./hermes-plugins.nix
  ];

  mine.hermes.agentProfiles = {
    enable = agentProfiles;
    profiles = import ./hermes-profiles-catalog.nix;
    inherit claudeConfigDir;

    # id and board must match kanban/boards/nixcfg/board.json; the link is by
    # id, and a wrong one degrades to a scratch workspace without an error.
    projects.nixcfg = {
      id = "p_43348f57";
      description = "Nix configuration repo: modules, hosts, ci, secrets";
      icon = "🐍";
      primaryPath = "/home/agent/projects/nixcfg";
    };
  };

  # Registers the catalog's `readonly` and `verify` toolsets; they are not built-ins.
  mine.hermes.agentPlugins = {
    enable = agentPlugins;
    plugins.least-privilege-toolsets.package = pkgs.callPackage ./hermes-plugins/package.nix { } {
      name = "least-privilege-toolsets";
      src = ./hermes-plugins/least-privilege-toolsets;
      providesToolsets = [
        "readonly"
        "verify"
      ];
    };
  };

  users.users.agent.linger = true;

  services.hermes-agent = {
    enable = true;
    user = "agent";
    group = "users";
    createUser = false;
    addToSystemPackages = true;
    environmentFiles = [ "/run/secrets/hermes-env" ];

    # Claude CLI for hermes terminal invocations. The unit PATH is a
    # narrow processPath, so claude must be added here explicitly;
    # the auth state lives in CLAUDE_CONFIG_DIR, not the default
    # ~/.claude. The raw binary (not the direnv-wrapped agentPkgs
    # entry) keeps `claude -p ...` from spawning a project devShell
    # inside the gateway.
    extraPackages = [ pkgs.claude-code ];
    environment.CLAUDE_CONFIG_DIR = claudeConfigDir;

    backend = {
      mode = "dashboard";
      inherit port;
    };

    settings = {
      model = {
        provider = "custom";
        inherit (llm) default;
        base_url = llm.baseUrl;
        api_key = "local";
        context_length = model.maxModelLen - model.headroom;
      };
      # max_in_progress counts only genuinely running tasks: a root triage card
      # that has fanned out is no longer running, so it holds no slot.
      # max_in_progress_per_profile is keyed per assignee name (GROUP BY
      # assignee), not a global writer cap -- claude-worker=3 plus
      # qwen-worker=3 permits up to 6 concurrent writers, bounded only by
      # max_in_progress; a backend-independent writer cap is not expressible
      # with this knob.
      kanban = {
        default_assignee = "claude-reader";
        orchestrator_profile = "claude-orchestrator";
        max_in_progress = 6;
        max_in_progress_per_profile = 3;
      };
      terminal.cwd = "/home/agent/projects";
      dashboard = {
        public_url = "https://${tailnetHostname}:${toString port}";
        basic_auth.username = "agent";
      };
    };
  };

  systemd.services.hermes-agent = asAgent;
  systemd.services.hermes-backend = asAgent;
}
