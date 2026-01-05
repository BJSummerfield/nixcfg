{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.user.alacritty;
  stylixEnabled = config.mine.user.stylix.enable;
in
{
  options.mine.user.alacritty = {
    enable = mkEnableOption "Alacritty Config";
  };

  config = mkIf cfg.enable {
    programs.alacritty = {
      enable = true;
      settings = {
        font = {
          normal.family = mkIf stylixEnabled config.stylix.fonts.monospace.name;
          size = 14;
        };
        window = {
          opacity = 0.8;
          decorations = "buttonless";
          padding = {
            x = 5;
            y = 5;
          };
        };
      };
    };
    home.sessionVariables = {
      TERMINAL = "alacritty";
    };

    catppuccin.alacritty.enable = true;
    stylix.targets.alacritty.enable = false;
    mine.user.niri.extraBinds = ''Mod+Return { spawn "${lib.getExe config.programs.alacritty.package}"; }'';
  };
}
