{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.mine.apps.printer;
in
{
  options.mine.apps.printer = {
    enable = mkEnableOption "Enable CUPs for printing";
    avahi = mkOption {
      type = types.bool;
      default = false;
      description = "Enable Avahi for cups";
    };
  };

  config = mkIf cfg.enable {
    services.printing.enable = true;

    services.avahi = mkIf cfg.avahi {
      enable = true;
      nssmdns4 = true;
      openFirewall = true;
    };
  };
}
