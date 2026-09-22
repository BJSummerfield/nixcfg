{ lib, config, ... }:
{
  options.mine.system.hermies = {
    desktop.enable = lib.mkEnableOption "Hermes desktop app (Homebrew cask)";
    gui.enable = lib.mkEnableOption "Hermes TUI (Homebrew hermes-agent formula)";
  };

  config = lib.mkMerge [
    (lib.mkIf config.mine.system.hermies.desktop.enable {
      homebrew.casks = [ "hermes-desktop" ];
    })
    (lib.mkIf config.mine.system.hermies.gui.enable {
      homebrew.brews = [ "hermes-agent" ];
    })
  ];
}
