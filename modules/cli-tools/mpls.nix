{ config, pkgs, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.mpls;
in
{
  options.mine.cli-tools.mpls = {
    expose = mkEnableOption "Expose the mpls package via an overlay";
    enable = mkEnableOption "Install the mpls package globally";
  };

  config = mkIf (cfg.enable || cfg.expose) {
    nixpkgs.overlays = [
      (self: super: {
        mpls = super.buildGoModule {
          pname = "mpls";
          version = "unstable";

          src = super.fetchFromGitHub {
            owner = "mhersson";
            repo = "mpls";
            rev = "main";
            hash = "sha256-z3miAbL3qQHusWoofUp8kNNZjoGANhPjeIj39KPYyvc=";
          };

          vendorHash = "sha256-xILlYrwcnMWAPACeELwVKGUBIK9QbrUSR03xVmNXsnE=";

          meta = {
            description = "Markdown preview language server";
            homepage = "https://github.com/mhersson/mpls";
            mainProgram = "mpls";
          };
        };
      })
    ];

    home-manager.users.${user.name} = mkIf cfg.enable {
      home.packages = [ pkgs.mpls ];
    };
  };
}
