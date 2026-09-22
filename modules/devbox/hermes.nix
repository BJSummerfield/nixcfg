{
  inputs,
  tailnetHostname,
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
  imports = [ inputs.hermes-agent.nixosModules.default ];

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
    environment.CLAUDE_CONFIG_DIR = "/home/agent/.claude-state";

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
