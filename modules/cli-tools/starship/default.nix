{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.starship;
in
{
  options.mine.cli-tools.starship = {
    enable = mkEnableOption "starship config";
  };

  config = mkIf cfg.enable {
    mine.cli-tools.starship.enable = true;
    home-manager.users.${user.name} = {
      programs.starship.enable = true;
    };
  };
}
