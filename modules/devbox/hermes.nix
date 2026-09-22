{
  inputs,
  tailnetHostname,
}:
{ lib, ... }:
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
      # Selectable Claude entry: alias `claude` -> built-in `anthropic` provider.
      # No api_key/base_url: the anthropic provider resolves its own endpoint and
      # borrows the logged-in Claude Code OAuth (CLAUDE_CONFIG_DIR, set by
      # wt/t_01612e3c / PR #201); no secret is stored here. The default stays the
      # local Qwen endpoint (untouched), so existing providers are undisturbed.
      # Model id matches the CLI-verified default for this Max login (1M ctx,
      # verified end-to-end in t_e512d30e: claude -p -> claude-opus-5[1m]).
      # (model_aliases entries take model/provider/base_url/api_key/key_env only;
      #  request timeouts are governed globally, not per-alias.)
      model_aliases = {
        claude = {
          model = "claude-opus-5";
          provider = "anthropic";
        };
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
