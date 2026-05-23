{ lib, config, ... }:
let
  inherit (lib) mkIf mkMerge;
  cfg = config.mine.user.fuzzel;
  niriCfg = config.mine.user.niri;
in
{
  options.mine.user.fuzzel.enable = lib.mkEnableOption "Fuzzel User config";

  config = mkIf cfg.enable (mkMerge [
    {
      programs.fuzzel = {
        enable = true;
        settings = {
          border.radius = 0;
        };
      };
      stylix.targets.fuzzel.enable = true;
    }

    (mkIf niriCfg.enable {
      xdg.configFile."niri/launcher.kdl".text = ''
        binds {
            Mod+Space {
                spawn-sh "${lib.getExe config.programs.fuzzel.package} --placeholder \"$(date)\""
            }
        }
      '';
    })
  ]);
}
