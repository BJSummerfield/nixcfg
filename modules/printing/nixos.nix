# Printing to the house printer, a Brother HL-L3220CDW on the LAN.
#
# No queue is declared here: the printer is driverless (advertises
# image/urf and image/pwg-raster in document-format-supported, plus
# _ipp._tcp and _universal over mDNS), so CUPS discovers it and builds a
# temporary queue at print time - the moment the network is guaranteed to
# be up.
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
