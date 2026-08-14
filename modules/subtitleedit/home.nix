{
  lib,
  config,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.mine.user.subtitleedit;
in
{
  options.mine.user.subtitleedit = {
    enable = mkEnableOption "Subtitle Edit with OCR support";
    languages = mkOption {
      type = with types; listOf str;
      default = [ "eng" ];
      description = "Tesseract OCR languages for subtitle extraction";
    };
  };

  config = mkIf cfg.enable {
    home.packages =
      let
        tesseractWithLangs = pkgs.tesseract.override {
          enableLanguages = cfg.languages;
        };
      in
      [
        pkgs.subtitleedit
        tesseractWithLangs
      ];
  };
}
