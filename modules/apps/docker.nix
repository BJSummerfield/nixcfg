{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.docker;
in
{
  options.mine.apps.docker = {
    enable = mkEnableOption "docker Config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      virtualisation.docker = {
        enable = false;
        rootless = {
          enable = true;
        };
      };
    };
  };
}
