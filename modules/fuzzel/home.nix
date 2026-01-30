{ lib, config, ... }:
{
  options.mine.user.fuzzel.enable = lib.mkEnableOption "Fuzzel User config";
  config = lib.mkIf config.mine.user.fuzzel.enable {
    programs.fuzzel = {
      enable = true;
      settings = {
        border.radius = 0;
      };
    };
    mine.user.niri.extraBinds = ''
      Mod+Space { 
        spawn-sh "${lib.getExe config.programs.fuzzel.package} --placeholder \"''$(date)\""; 
      }
    '';
    catppuccin.fuzzel.enable = true;
  };
}
