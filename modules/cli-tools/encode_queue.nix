{ config, pkgs, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.encode_queue;
in
{
  options.mine.cli-tools.encode_queue = {
    enable = mkEnableOption "Install the package from the user";
  };

  config = mkIf cfg.enable {
    nixpkgs.overlays = [
      (self: super: {
        encode_queue = super.rustPlatform.buildRustPackage {
          #fixes build warning in nixos
          useFetchCargoVendor = true;
          pname = "encode_queue";
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
      home.packages = [ pkgs.encode_queue ];
    };
  };
}
