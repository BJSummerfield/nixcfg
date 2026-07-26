{ lib, config, pkgs, ... }:
{
  options.mine.system.cups-server = lib.mkEnableOption "Enable CUPS printing server";

  config = lib.mkIf config.mine.system.cups-server {
    services.printing = {
      enable = true;
      openFirewall = true;
      webInterface = true;
      drivers = [ pkgs.cups-filters ];
    };

    services.avahi = {
      enable = true;
      nssmdns4 = true;
      publish = {
        enable = true;
        addresses = true;
        userServices = true;
      };
    };
  };
}
