{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.ghostty;
in
{
  options.mine.apps.ghostty = {
    enable = mkEnableOption "ghostty Config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.ghostty = {
        enable = true;
        settings = {
          background-opacity = 0.9;
          background-blur-radius = 15;
          keybind = [
            "alt+left=unbind"
            "alt+right=unbind"
          ];
        };
      };
      home.sessionVariables = {
        TERMINAL = "ghostty";
      };
    };
  };
}
