# The keybase app on darwin runs and manages its own services; the
# Linux-only home module is what starts the daemon and kbfs there.
{ lib, config, ... }:
{
  options.mine.system.keybase.enable = lib.mkEnableOption "Keybase from homebrew";

  config = lib.mkIf config.mine.system.keybase.enable {
    homebrew.casks = [ "keybase" ];
  };
}
