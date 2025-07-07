{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.desktop.fuzzel;
in
{
  options.mine.desktop.fuzzel = {
    enable = mkEnableOption "Enable fuzzel config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.fuzzel = {
        enable = true;
        settings = {
          border.radius = 0;
        };
      };
    };
  };
}
