{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.claude-code;

  # `claude` everywhere is the sandbox launcher from the coding-agents
  # module; the real host install answers to claude-host, the escape
  # hatch for sessions that must touch the machine itself (nixcfg,
  # darwin-rebuild, servers).
  claudeHost = pkgs.writeShellScriptBin "claude-host" ''
    exec ${lib.getExe pkgs.claude-code} "$@"
  '';
in
{
  options.mine.user.claude-code = {
    enable = mkEnableOption "Claude Code AI coding agent";
  };
  config = mkIf cfg.enable {
    mine.allowedUnfree = [ "claude-code" ];
    home.packages = [ claudeHost ];
  };
}
