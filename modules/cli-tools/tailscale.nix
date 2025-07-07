{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.tailscale;
in
{

  options.mine.cli-tools.tailscale.enable = mkEnableOption "Enable Tailscale";
  config = mkIf cfg.enable {
    services.tailscale.enable = true;
  };
}
