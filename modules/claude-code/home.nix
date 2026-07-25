{ lib, config, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.claude-code;
in
{
  options.mine.user.claude-code = {
    enable = mkEnableOption "Claude Code AI coding agent";
  };
  config = mkIf cfg.enable {
    mine.allowedUnfree = [ "claude-code" ];
    home.packages = [ pkgs.claude-code ];
  };
}
