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
          colors = {
            background = "1e1e2edd";
            text = "cdd6f4ff";
            prompt = "bac2deff";
            placeholder = "7f849cff";
            input = "cdd6f4ff";
            match = "89b4faff";
            selection = "585b70ff";
            selection-text = "cdd6f4ff";
            selection-match = "89b4faff";
            counter = "7f849cff";
            border = "89b4faff";
          };
        };
      };
    }

    (mkIf niriCfg.enable {
      mine.user.niri.extraBinds = ''
        Mod+Space {
            spawn-sh "${lib.getExe config.programs.fuzzel.package} --placeholder \"$(date)\""
        }
      '';
    })
  ]);
}
