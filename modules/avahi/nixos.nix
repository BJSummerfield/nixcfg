{ lib, config, ... }:
{
  options.mine.system.avahi.enable = lib.mkEnableOption "Enable avahi service";

  config = lib.mkIf config.mine.system.avahi.enable {
    services.avahi = {
      enable = true;
      nssmdns4 = true;
      openFirewall = true;
    };
  };
}
