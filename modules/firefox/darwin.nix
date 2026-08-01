# Unmanaged on darwin by choice: just the app from homebrew, configured
# by hand. The managed profile/policies module is Linux-only.
{ lib, config, ... }:
{
  options.mine.system.firefox.enable = lib.mkEnableOption "Firefox from homebrew";

  config = lib.mkIf config.mine.system.firefox.enable {
    homebrew.casks = [ "firefox" ];
  };
}
