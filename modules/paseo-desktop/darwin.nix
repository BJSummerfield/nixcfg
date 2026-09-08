{ lib, config, ... }:
{
  options.mine.system.paseo-desktop.enable = lib.mkEnableOption "Paseo desktop app from homebrew";

  config = lib.mkIf config.mine.system.paseo-desktop.enable {
    homebrew.casks = [ "paseo" ];

    home-manager.sharedModules = [ { mine.user.paseo-desktop.enable = true; } ];
  };
}
