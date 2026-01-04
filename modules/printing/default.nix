{ lib, config, ... }:
{
  options.mine.system.printer.enable = lib.mkEnableOption "Enable printing service";

  config = lib.mkIf config.mine.system.printer.enable {
    services.printing.enable = true;
  };
}
