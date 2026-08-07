# Pure data: opencode config consumed by home.nix (host/container HM) and
# by the coding-agents docker image.
#
# The redtruck provider's model list and default are derived from
# modules/local-llm/models.nix, the single source of truth for what's served
# there. Aliases are not registered here - they exist for pi's subagent
# tiers, and opencode has no tier system, so a second entry for the same
# weights would just be noise in its picker. robin is a different machine
# with its own hand-run server, so it stays hand-written.
let
  llm = import ../local-llm/models.nix;

  mkModel = name:
    let m = llm.models.${name}; in
    {
      name = name;
      value = {
        limit = {
          context = m.maxModelLen - m.headroom;
          output = m.maxTokens;
        };
        options = m.sampling;
      };
    };

  redtruckModels = builtins.listToAttrs (map mkModel llm.enabled);
in
{
  settings = {
    "$schema" = "https://opencode.ai/config.json";
    model = "${llm.provider}/${llm.default}";
    provider."${llm.provider}" = {
      options.baseURL = llm.baseUrl;
      models = redtruckModels;
    };
    provider."robin" = {
      options.baseURL = "http://84.216.57.22:8080/v1";
      models."unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF" = {
        options = {
          temperature = 0.7;
          top_p = 0.8;
          top_k = 20;
          min_p = 0.0;
          repetition_penalty = 1.05;
        };
      };
    };
    enabled_providers = [ llm.provider "robin" ];
  };
}
