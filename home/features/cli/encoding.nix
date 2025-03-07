{ config
, pkgs
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.git;
  encode_queue = pkgs.rustPlatform.buildRustPackage {
    pname = "encode-queue";
    version = "unstable";
    src = pkgs.fetchFromGitHub {
      owner = "BJSummerfield";
      repo = "encode_queue";
      rev = "main"; # pull from the main branch
      sha256 = "sha256-jUDG5pjkWHTWOoyV7f6Bdmel8ZzNX1VtG9ZXRD709Kc=";
    };
    cargoHash = "sha256-lmElNMLEg1SqQp+mupjYzQwQQn7B5CVfLBI0rB5jpH0=";
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
