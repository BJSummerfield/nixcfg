{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.home-manager.cli-tools.direnv;
in
{
  options.mine.home-manager.cli-tools.direnv = {
    enable = mkEnableOption "direnv config";
  };

  config = mkIf cfg.enable {
    mine.home-manager.cli-tools.direnv.enable = true;
    home-manager.users.${user.name} = {
      programs.direnv = {
        enable = true;
        nix-direnv.enable = true;
      };
    };
  };
}
