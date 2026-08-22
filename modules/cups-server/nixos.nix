{
  lib,
  config,
  pkgs,
  ...
}:
{
  options.mine.system.cups-server = lib.mkEnableOption "Enable CUPS printing server";

  config = lib.mkIf config.mine.system.cups-server {
    services.printing = {
      enable = true;
      # Bind on every interface. The default (localhost:631) kept the
      # daemon reachable only from paynefield itself, so the other
      # machines could never actually connect.
      listenAddresses = [ "*:631" ];
      # Allow IPP from other hosts. The default is `Allow localhost` only,
      # which 403s remote requests even when the port is reachable.
      allowFrom = [ "all" ];
      # cupsd opens its own sockets, so run it as a plain daemon; the
      # systemd socket would grab the wildcard ports first.
      startWhenNeeded = false;
      # Advertise shared printers over mDNS so clients can discover the
      # queues (AirPrint, ipp://paynefield.local:631/printers/<queue>).
      browsing = true;
      defaultShared = true;
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
