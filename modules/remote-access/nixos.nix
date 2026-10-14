{ lib, config, ... }:
let
  cfg = config.mine.system.remoteAccess;
in
{
  options.mine.system.remoteAccess = {
    enable = lib.mkEnableOption "Tailscale with SSH over the tailnet";
    lanAccess = lib.mkEnableOption "SSH on the external interface (trusted LAN only)";
    authorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = lib.attrNames config.mine.users.waktu.sshKeys;
    };
  };

  config = lib.mkIf cfg.enable {
    mine.system.tailscale = {
      enable = true;
      ssh = true;
    };

    mine.system.openssh.inbound = {
      enable = true;
      openOnExternalInterface = cfg.lanAccess;
    };

    mine.users.waktu.authorizedKeys = cfg.authorizedKeys;
  };
}
