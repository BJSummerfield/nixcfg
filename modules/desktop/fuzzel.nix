{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkMerge mkIf mkOption types;
  inherit (config.mine) user;
  cfg = config.mine.apps.alacritty;
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
        settings = mkMerge [
          {
            border.radius = 0;
          }
          (mkIf cfg.uwsm {
            main = {
              launch-prefix = "uwsm app -- ";
            };
          })
        ];
      };
    };
  };
}
