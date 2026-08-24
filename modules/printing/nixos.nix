# Printing to the house printer, a Brother HL-L3220CDW on the LAN.
#
# The printer is driverless: it reports image/urf (AirPrint) and
# image/pwg-raster (IPP Everywhere) in document-format-supported, and its
# device-id carries a URF block. So no Brother driver is needed here or
# anywhere else - `model = "everywhere"` has cupsd build the PPD by asking
# the printer what it can do.
#
# A local cupsd is not optional: every GTK/Qt print dialog spools through
# one. What *is* optional - and deliberately not used - is discovery. CUPS
# would happily find the printer over mDNS and conjure a temporary queue per
# job, but those queues are torn down after a minute idle, so the printer
# keeps vanishing from the printer list and every print feels like a fresh
# setup. The declarative queue below exists from activation onward and is
# re-asserted on every rebuild, which is the whole point.
{ lib, config, ... }:
let
  cfg = config.mine.system.printing;
in
{
  options.mine.system.printing.enable = lib.mkEnableOption "Enable printing to the house printer";

  config = lib.mkIf cfg.enable {
    services.printing = {
      enable = true;
      # browsed.enable defaults to services.avahi.enable, so enabling avahi
      # would silently start cups-browsed. Its own CreateIPPPrinterQueues
      # default is LocalOnly, meaning it ignores network printers entirely -
      # it would discover nothing and just sit there. The queue is declared
      # below instead.
      browsed.enable = false;
    };

    # Resolves the printer's .local name. Using the name rather than an
    # address keeps a DHCP reservation off the list of things that can
    # silently break printing.
    mine.system.avahi.enable = true;

    hardware.printers = {
      ensurePrinters = [
        {
          name = "brother";
          deviceUri = "ipp://BRW58CDC98907E0.local/ipp/print";
          model = "everywhere";
        }
      ];
      ensureDefaultPrinter = "brother";
    };

    # ensure-printers resolves a .local name and then queries the printer over
    # IPP, so it needs avahi answering first. Upstream only orders it after
    # cups.service.
    systemd.services.ensure-printers.after = [ "avahi-daemon.service" ];
  };
}
