{ config
, pkgs
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.git;
  encode_queue = pkgs.rustPlatform.buildRustPackage {
    #fixes build warning in nixos
    useFetchCargoVendor = true;
    pname = "encode-queue";
    version = "unstable";
    src = pkgs.fetchFromGitHub {
      owner = "BJSummerfield";
      repo = "encode_queue";
      rev = "main";
      sha256 = "sha256-jUDG5pjkWHTWOoyV7f6Bdmel8ZzNX1VtG9ZXRD709Kc=";
    };
    cargoHash = "sha256-3hfXLgVzT088UAMfxE7ao86nO7Gx8MHwi+9rLBrYYQw=";
  };
in
{
  options.features.cli.encoding.enable = mkEnableOption "enable encoding configuration";

  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      ffmpeg
      encode_queue
    ];
  };
}
