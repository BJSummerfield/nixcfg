# Homebrew cask rather than the nix package: the darwin build runs electron-builder
# and a full Expo web export.
{ lib, config, ... }:
{
  options.mine.system.paseo-desktop.enable =
    lib.mkEnableOption "Paseo desktop app from homebrew";

  config = lib.mkIf config.mine.system.paseo-desktop.enable {
    homebrew.casks = [ "paseo" ];

    # The cask flag implies the client-mode settings seed.
    home-manager.sharedModules = [{ mine.user.paseo-desktop.enable = true; }];
  };
}
