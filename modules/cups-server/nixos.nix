{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.cups-server;
  externalInterface = config.mine.system.externalInterface;
in
{
  options.mine.system.cups-server = lib.mkEnableOption "Enable CUPS printing server";

  config = lib.mkMerge [
    (lib.mkIf cfg {
      assertions = [
        {
          assertion = externalInterface != null;
          message = ''
            mine.system.cups-server is enabled but
            mine.system.externalInterface is not set. Set externalInterface
            to the name of the LAN NIC so port 631 can be opened on it.
          '';
        }
      ];

      services.printing = {
        enable = true;
        # cupsd binds on every interface; the firewall rule below
        # decides who can actually reach port 631.
        listenAddresses = [ "*:631" ];
        # Allow everything the firewall lets through; per-source scoping
        # is the interface rule below, not an Allow list here.
        allowFrom = [ "all" ];
        # cupsd opens its own sockets, so run it as a plain daemon; the
        # systemd socket would grab the wildcard ports first.
        startWhenNeeded = false;
        # Advertise shared printers over mDNS so clients can discover the
        # queues (AirPrint, ipp://paynefield.local:631/printers/<queue>).
        browsing = true;
        defaultShared = true;
        # LAN only: per-interface rule below, not a global open.
        openFirewall = false;
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
    })

    (lib.mkIf (cfg && externalInterface != null) {
      # LAN only: open 631 on the home NIC; every other interface
      # (including tailscale0) falls through to the default reject.
      networking.firewall.interfaces = {
        ${externalInterface}.allowedTCPPorts = [ 631 ];
      };
    })
  ];
}
