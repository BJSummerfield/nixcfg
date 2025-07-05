{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.system.allowUnfree;
in
{
  # TODO this could be set to allow for specific packages
  options.mine.system.allowUnfree = {
    enable = mkEnableOption "Enable Unfree packages";
  };

  config = mkIf cfg.enable {
    nixpkgs.config.allowUnfree = true;

    home-manager.users.${user.name} = {
      nixpkgs.config.allowUnfree = true;
    };
  };
}
