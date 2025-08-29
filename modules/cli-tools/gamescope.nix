{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.gamescope;
in
{
  options.mine.cli-tools.gamescope = {
    enable = mkEnableOption "Enable gamescope compositor";
    overlay = mkEnableOption "User Gamescope Overlay";
  };

  config = mkIf cfg.enable {
    programs.gamescope.enable = true;
    nixpkgs.overlays = mkIf cfg.overlay [
      (self: super: {
        gamescope = super.gamescope.overrideAttrs {
          version = "3.16.15";
          src = super.fetchFromGitHub {
            owner = "ValveSoftware";
            repo = "gamescope";
            tag = "3.16.15";
            fetchSubmodules = true;
            hash = "sha256-/JMk1ZzcVDdgvTYC+HQL09CiFDmQYWcu6/uDNgYDfdM=";
          };
        };
      })
    ];
  };
}
