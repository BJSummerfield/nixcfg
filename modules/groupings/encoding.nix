{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf optionals;
  inherit (config.mine) user;
  cfg = config.mine.groupings.encoding;
in
{
  options.mine.groupings.encoding = {
    encode_queue = mkEnableOption "Enable encode_queue cli tool";
    ffmpeg = mkEnableOption "Enable ffmpeg";
    subtitleedit = mkEnableOption "Enable subtitleedit";
    makemkv = mkEnableOption "Enable makemkv";
    abcde = mkEnableOption "Enable abcde (CD ripper)";
    picard = mkEnableOption "Enable picard (MusicBrainz tagger)";
  };

  config = {
    mine.cli-tools.encode_queue.enable = mkIf cfg.encode_queue true;

    home-manager.users.${user.name} = {
      home.packages = with pkgs;
        (optionals cfg.ffmpeg [ ffmpeg ]) ++
        (optionals cfg.subtitleedit [ subtitleedit ]) ++
        (optionals cfg.makemkv [ makemkv ]) ++
        (optionals cfg.abcde [ abcde ]) ++
        (optionals cfg.picard [ picard ]);
    };
  };
}
