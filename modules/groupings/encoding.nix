{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.groupings.encoding;
in
{
  options.mine.groupings.encoding.enable = mkEnableOption "enable encoding configuration";

  config = mkIf cfg.enable {
    mine.cli-tools.encode_queue.enable = true;

    home-manager.users.${user.name} = {
      home.packages = with pkgs; [
        ffmpeg
        subtitleedit
        makemkv
        abcde
        picard
      ];
    };
  };
}
