{ lib, config, themeConstants, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.mako;
  inherit (themeConstants) colors;
in
{
  options.mine.user.mako.enable = mkEnableOption "Enable Mako config";
  config = mkIf cfg.enable {
    services.mako = {
      enable = true;
      settings = {
        background-color = "#${colors.base00}cc";
        text-color = "#${colors.base05}";
        border-color = "#${colors.base0D}";
        progress-color = "over #${colors.base01}";
        font = "${themeConstants.fonts.monospace.name} ${toString themeConstants.fonts.sizes.popups}";
        anchor = "top-right";
        layer = "overlay";
        margin = "0";
        padding = "10";
        width = 400;
        max-visible = 5;
        border-size = 1;
        outer-margin = "0";


        default-timeout = 10000;
        sort = "-time";
        history = true;

        "urgency=critical" = {
          background-color = "#${colors.base00}cc";
          text-color = "#${colors.base05}";
          border-color = "#${colors.base08}";
          default-timeout = 0;
        };
        "urgency=low" = {
          background-color = "#${colors.base00}cc";
          text-color = "#${colors.base05}";
          border-color = "#${colors.base03}";
        };
      };
    };
  };
}
