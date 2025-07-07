{ config, pkgs, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.comq;
in
{
  options.mine.cli-tools.comq = {
    expose = mkEnableOption "Expose the comq package via an overlay";
    enable = mkEnableOption "Install the package from the user";
  };

  config = mkIf (cfg.enable || cfg.expose) {
    nixpkgs.overlays = [
      (self: super: {
        encodeq = super.rustPlatform.buildRustPackage {
          #fixes build warning in nixos
          useFetchCargoVendor = true;
          pname = "comq";
          version = "unstable";

          src = super.fetchFromGitHub {
            owner = "BJSummerfield";
            repo = "encode_queue";
            rev = "main";
            sha256 = "sha256-jUDG5pjkWHTWOoyV7f6Bdmel8ZzNX1VtG9ZXRD709Kc=";

          };
          cargoHash = "sha256-3hfXLgVzT088UAMfxE7ao86nO7Gx8MHwi+9rLBrYYQw=";
        };
      })
    ];
    home-manager.users.${user.name} = mkIf cfg.enable {
      home.packages = [ pkgs.comq ];
    };
  };
}
