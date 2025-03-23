{ config
, pkgs
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.encoding;
in
{
  options.features.cli.encoding.enable = mkEnableOption "enable encoding configuration";

  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      ffmpeg
      encode_queue
      subtitleedit
      makemkv
    ];
  };
}
