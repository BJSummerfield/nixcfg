{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.eza;
in
{
  options.mine.cli-tools.eza = {
    enable = mkEnableOption "Eza config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.eza.enable = true;
    };
  };
}
