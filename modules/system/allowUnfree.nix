{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.system.allowUnfree;
in
{
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
