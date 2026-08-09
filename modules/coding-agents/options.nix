# Shared options for coding-agent sandboxes: module enable and per-agent toggles.
lib:
let
  inherit (lib) mkEnableOption mkOption types;
  mkAgent = name: mkOption {
    type = types.bool;
    default = true;
    description = "Provide the ${name} launcher (and its container payload) on this host.";
  };
in
{
  mkAgentOptions = {
    enable = mkEnableOption "coding agents (pi, opencode, claude), each session in its own ephemeral container";
    agents = {
      pi = mkAgent "pi";
      opencode = mkAgent "opencode";
      claude = mkAgent "claude";
    };
  };
}
