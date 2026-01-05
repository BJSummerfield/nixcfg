{ lib, config, ... }:
{
  options.mine.system.printing.enable = lib.mkEnableOption "Enable printing service";

  config = lib.mkIf config.mine.system.printing.enable {
    services.printing.enable = true;
  };
}
