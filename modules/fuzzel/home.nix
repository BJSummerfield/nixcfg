{ lib, config, themeConstants, ... }:
let
  inherit (lib) mkIf mkMerge;
  cfg = config.mine.user.fuzzel;
  niriCfg = config.mine.user.niri;
  inherit (themeConstants) colors;
  font = "${themeConstants.fonts.sansSerif.name} ${toString themeConstants.fonts.sizes.popups}";
  fuzzelCfg = ''
    [colors]
    background=${colors.base00}dd
    text=${colors.base05}ff
    prompt=${colors.subtext1}ff
    placeholder=${colors.overlay1}ff
    input=${colors.base05}ff
    match=${colors.base0D}ff
    selection=${colors.surface2}ff
    selection-text=${colors.base05}ff
    selection-match=${colors.base0D}ff
    counter=${colors.overlay1}ff
    border=${colors.base0D}ff

    [main]
    font=${font}
    border-radius=0
  '';
in
{
  options.mine.user.fuzzel.enable = lib.mkEnableOption "Fuzzel User config";

  config = mkIf cfg.enable (mkMerge [
    {
      xdg.configFile."fuzzel/fuzzel.ini".text = fuzzelCfg;
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
