{ lib, config, pkgs, ... }:
{
  options.mine.system.printing.enable = lib.mkEnableOption "Enable printing service";

  config = lib.mkIf config.mine.system.printing.enable {
    services.printing = {
      enable = true;
      drivers = with pkgs; [
        cups-filters
      ];
    };

    services.avahi.publish.enable = true;
    services.avahi.publish.userServices = true;
  };
}
