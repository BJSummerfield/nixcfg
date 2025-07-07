{ config, ... }:
let
  inherit (config.mine) user;
in
{
  config = {
    services.rpcbind.enable = true;
    fileSystems = {
      "${user.homeDir}/media" = {
        device = "/dev/disk/by-uuid/f9c0acb3-2ce3-4e63-baa0-6d31cca413e1";
        fsType = "ext4";
      };
      "${user.homeDir}/games" = {
        device = "/dev/disk/by-uuid/ee353e06-2eb1-4df2-bc2d-22c0e8b37bd9";
        fsType = "ext4";
      };
      "${user.homeDir}/data1" = {
        device = "/dev/disk/by-uuid/7d4a0f34-b26e-4b40-8eb5-07707af967e6";
        fsType = "ext4";
      };
      "${user.homeDir}/data2" = {
        device = "/dev/disk/by-uuid/41e816f6-22c4-4230-8788-c3386f029c54";
        fsType = "ext4";
      };
      "${user.homeDir}/nas" = {
        device = "192.168.1.234:/volume1/data"; # NFS server and share path
        fsType = "nfs";
        options = [
          "x-systemd.automount" # Only mount when accessed
          "noauto" # Prevents blocking boot if unavailable
          "x-systemd.idle-timeout=600" # Unmount after 10 minutes of inactivity
          "nfsvers=3" # Explicitly use NFSv3 (since Synology defaults to v3)
          "soft" # Prevents hanging on network issues
          "timeo=150" # Faster timeout in case of network failure
          "retrans=2" # Retries mount requests twice before failing
        ];
      };
    };
  };
}
