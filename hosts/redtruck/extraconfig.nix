{ ... }:
{
  home-manager.sharedModules = [
    ({ config, lib, ... }: {
      mine.user.niri = {
        outputs = {
          "DP-1" = {
            mode = "3440x1440@174.963";
            variableRefreshRate = true;
            scale = 1.0;
          };
        };
        extraWindowRules = lib.mkMerge [
          ''
            // VRR settings for Games
            window-rule {
                match app-id="gamescope"
                match app-id="dota2"
                match app-id="Hollow Knight Silksong"
                match app-id="steam_app_553850"
                variable-refresh-rate true
            }
          ''
          (lib.mkIf (config.mine.user.alacritty.enable) ''
            // Wider Alacritty windows
            window-rule {
                match app-id="Alacritty"
                default-column-width { proportion 0.33333; }
            }
          '')
        ];
      };
    })
  ];
}
