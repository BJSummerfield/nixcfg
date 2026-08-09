# Keybase manages its own services on darwin; the Linux module handles daemons.
{ lib, config, ... }:
{
  options.mine.system.keybase.enable = lib.mkEnableOption "Keybase from homebrew";

  config = lib.mkIf config.mine.system.keybase.enable {
    homebrew.casks = [ "keybase" ];
  };
}
