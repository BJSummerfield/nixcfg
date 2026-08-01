{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.opencode;
in
{
  options.mine.user.opencode = {
    enable = mkEnableOption "opencode AI coding agent";
  };
  config = mkIf cfg.enable {
    programs.opencode = {
      enable = true;
      tui = {
        theme = "system";
      };
      settings = (import ./settings.nix).settings;
    };
  };
}
