# Firefox is unmanaged on darwin — homebrew cask only, configured manually.
{ lib, config, ... }:
{
  options.mine.system.firefox.enable = lib.mkEnableOption "Firefox from homebrew";

  config = lib.mkIf config.mine.system.firefox.enable {
    homebrew.casks = [ "firefox" ];
  };
}
