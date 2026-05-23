{ lib, osConfig, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  cfg = config.mine.user.alacritty;
  niriCfg = config.mine.user.niri;
  stylixEnabled = osConfig.mine.system.stylix.enable;

in
{
  options.mine.user.alacritty = {
    enable = mkEnableOption "Alacritty Config";
  };

  config = mkIf cfg.enable (mkMerge [
    {
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
    }

    (mkIf niriCfg.enable {
      xdg.configFile."niri/terminal.kdl".text = ''
        binds {
            Mod+Return { spawn "${lib.getExe config.programs.alacritty.package}"; }
        }
      '';
    })
  ]);
}
