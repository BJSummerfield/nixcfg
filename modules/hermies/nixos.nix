{ lib, config, ... }:
{
  options.mine.system.hermies = {
    desktop.enable = lib.mkEnableOption "Hermes desktop app (nix package)";
    gui.enable = lib.mkEnableOption "Hermes TUI (nix package)";
    desktop.package = lib.mkOption {
      type = lib.types.package;
      description = "Hermes desktop package, set by the host from inputs.hermes-agent";
    };
    gui.package = lib.mkOption {
      type = lib.types.package;
      description = "Hermes TUI package, set by the host from inputs.hermes-agent";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf config.mine.system.hermies.desktop.enable {
      environment.systemPackages = [ config.mine.system.hermies.desktop.package ];
    })
    (lib.mkIf config.mine.system.hermies.gui.enable {
      environment.systemPackages = [ config.mine.system.hermies.gui.package ];
    })
  ];
}
