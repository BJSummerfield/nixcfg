{ lib, config, ... }:
{
  options.mine.system.keybase.enable = lib.mkEnableOption "Keybase from homebrew";

  config = lib.mkIf config.mine.system.keybase.enable {
    homebrew.casks = [ "keybase" ];
  };
}
