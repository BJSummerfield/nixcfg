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
            hash = "sha256-ChEZigLKzU/SILcJoyjKZI1qqrAi9qA6ugUeg5AL2Mw=";
          };

          vendorHash = "sha256-n3DG3sR7HOQPQJW1t1qC94EKkDBgXpdmjUWtLzAE7kY=";

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
