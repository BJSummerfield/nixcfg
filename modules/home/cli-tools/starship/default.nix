{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.home-manager.cli-tools.starship;
in
{
  options.mine.home-manager.cli-tools.starship = {
    enable = mkEnableOption "starship config";
  };

  config = mkIf cfg.enable {
    mine.home-manager.cli-tools.starship.enable = true;
    home-manager.users.${user.name} = {
      programs.starship.enable = true;
    };
  };
}
