# Printing to the house printer, a Brother HL-L3220CDW on the LAN.
#
# There is deliberately no queue declared here. The printer is driverless -
# it advertises itself over mDNS as _ipp._tcp plus the _universal AirPrint
# subtype - so CUPS discovers it and builds a temporary queue at print time,
# which is the moment the network is guaranteed to be up. A local cupsd is
# not optional either way: every GTK/Qt print dialog spools through one.
#
# An earlier version declared the queue with
# hardware.printers.ensurePrinters instead: `lpadmin` runs at boot, the one
# moment WiFi has not associated yet, so it failed on every boot.
{ lib, config, ... }:
let
  cfg = config.mine.system.printing;
in
{
  options.mine.system.printing.enable = lib.mkEnableOption "Enable printing to the house printer";

  config = lib.mkIf cfg.enable {
    services.printing = {
      enable = true;
      # Defaults to services.avahi.enable, which would otherwise start it;
      # its CreateIPPPrinterQueues default (LocalOnly) ignores network
      # printers anyway - discovery that matters happens in cupsd itself.
      browsed.enable = false;
    };

    # cupsd finds the printer by talking to avahi over D-Bus.
    mine.system.avahi.enable = true;
  };
}
