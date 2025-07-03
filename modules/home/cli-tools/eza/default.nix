{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.home-manager.cli-tools.eza;
in
{
  options.mine.home-manager.cli-tools.eza = {
    enable = mkEnableOption "Eza config";
  };

  config = mkIf cfg.enable {
    mine.home-manager.cli-tools.eza.enable = true;
    home-manager.users.${user.name} = {
      programs.eza.enable = true;
    };
  };
}
