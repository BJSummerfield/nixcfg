{ ... }:
{
  home-manager.sharedModules = [
    ({ config, lib, ... }: {
      mine.user.niri = {
        extraWindowRules = lib.mkIf (config.mine.user.alacritty.enable) ''
          // Wider Alacritty windows
          window-rule {
              match app-id="Alacritty"
              default-column-width { proportion 0.33333; }
          }
        '';
      };
    })
  ];
}
