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
  };

  # The profile catalog's `readonly` and `verify` toolsets are not built-in
  # names - this plugin is what registers them. Turning it off leaves those
  # profiles resolving to no tools, so hermes-plugins.nix asserts against
  # that combination rather than letting it boot.
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
