{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  inherit (config.mine) user;
  cfg = config.mine.desktop.fuzzel;
in
{
  options.mine.desktop.fuzzel = {
    enable = mkEnableOption "Enable fuzzel config";
    uwsm = mkOption {
      type = types.bool;
      default = false;
      description = "Enable UWSM integration for fuzzel, setting launch-prefix.";
    };
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.fuzzel = {
        enable = true;
        settings = {
          border.radius = 0;
          main = {
            launch-prefix = mkIf cfg.uwsm "uwsm app -- ";
          };
        };
      };
    };
  };
}
