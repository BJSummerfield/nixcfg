{
  lib,
  config,
  pkgs,
  inputs,
  ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
in
{
  options.mine.system.hermies = {
    desktop.enable = lib.mkEnableOption "Hermes desktop app (hermes-agent flake input)";
    gui.enable = lib.mkEnableOption "Hermes TUI (hermes-agent flake input)";
  };

  config = lib.mkMerge [
    (lib.mkIf config.mine.system.hermies.desktop.enable {
      environment.systemPackages = [ inputs.hermes-agent.packages.${system}.desktop ];
    })
    (lib.mkIf config.mine.system.hermies.gui.enable {
      environment.systemPackages = [ inputs.hermes-agent.packages.${system}.tui ];
    })
  ];
}
