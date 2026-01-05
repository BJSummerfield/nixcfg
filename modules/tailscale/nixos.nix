{ config, lib, ... }:
{
  options.mine.system.tailscale.enable = lib.mkEnableOption "Enable Tailscale";
  config = lib.mkIf config.mine.system.tailscale.enable {
    services.tailscale.enable = true;
  };
}
