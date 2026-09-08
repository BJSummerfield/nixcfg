{ lib, config, ... }:
let
  cfg = config.mine.system.printing;
in
{
  options.mine.system.printing.enable = lib.mkEnableOption "Enable printing to the house printer";

  config = lib.mkIf cfg.enable {
    services.printing = {
      enable = true;
      browsed.enable = false;
    };

    mine.system.avahi.enable = true;
  };
}
