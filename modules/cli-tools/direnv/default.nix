{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.direnv;
in
{
  options.mine.cli-tools.direnv = {
    enable = mkEnableOption "direnv config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.direnv = {
        enable = true;
        nix-direnv.enable = true;
      };
    };
  };
}
