{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  cfg = config.mine.user.alacritty;
  niriCfg = config.mine.user.niri;

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
          window = {
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
