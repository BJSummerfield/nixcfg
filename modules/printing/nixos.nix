# Printing to the house printer, a Brother HL-L3220CDW on the LAN.
#
# There is deliberately no queue declared here. The printer is driverless -
# it reports image/urf and image/pwg-raster in document-format-supported and
# advertises itself over mDNS as _ipp._tcp plus the _universal AirPrint
# subtype - so CUPS discovers it and builds a temporary queue at print time,
# which is the moment the network is guaranteed to be up.
#
# An earlier version declared the queue with hardware.printers.ensurePrinters
# instead. That runs `lpadmin` during boot, which is the one moment WiFi has
# not associated yet, so it failed on every boot and the queue never existed.
# Setup has to happen when the printer is reachable, and only printing knows
# when that is.
#
# A local cupsd is not optional either way: every GTK/Qt print dialog spools
# through one.
{ lib, config, ... }:
let
  cfg = config.mine.system.printing;
in
{
  options.mine.system.printing.enable = lib.mkEnableOption "Enable printing to the house printer";

  config = lib.mkIf cfg.enable {
    services.printing = {
      enable = true;
      # Defaults to services.avahi.enable, so avahi below would otherwise
      # start it. Its own CreateIPPPrinterQueues default is LocalOnly, meaning
      # it ignores network printers entirely - it would discover nothing and
      # just sit there. Discovery that matters happens in cupsd itself.
      browsed.enable = false;
    };

    # cupsd finds the printer by talking to avahi over D-Bus.
    mine.system.avahi.enable = true;
  };
}
