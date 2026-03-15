{ ... }:
let
  stdOptions = [ "defaults" "nofail" ];
in
{
  mine.system.bootPartitionUuid = "360f73f5-1bf7-4111-aff0-be9b1a4dd579";

  fileSystems = {
    "/mnt/media" = {
      device = "/dev/disk/by-uuid/f9c0acb3-2ce3-4e63-baa0-6d31cca413e1";
      fsType = "ext4";
      options = stdOptions;
    };

    "/mnt/games" = {
      device = "/dev/disk/by-uuid/ee353e06-2eb1-4df2-bc2d-22c0e8b37bd9";
      fsType = "ext4";
      options = stdOptions;
    };

    "/mnt/data1" = {
      device = "/dev/disk/by-uuid/7d4a0f34-b26e-4b40-8eb5-07707af967e6";
      fsType = "ext4";
      options = stdOptions;
    };

    "/mnt/data2" = {
      device = "/dev/disk/by-uuid/41e816f6-22c4-4230-8788-c3386f029c54";
      fsType = "ext4";
      options = stdOptions;
    };
  };

  # Steam writes to this directory
  systemd.tmpfiles.rules = [
    "d /mnt/games 2770 root users -"
  ];

  home-manager.sharedModules = [
    ({ config, ... }:
      let
        mkLink = config.lib.file.mkOutOfStoreSymlink;
      in
      {
        home.file = {
          "games".source = mkLink "/mnt/games";
          "media".source = mkLink "/mnt/media";
          "data1".source = mkLink "/mnt/data1";
          "data2".source = mkLink "/mnt/data2";
        };
      })
  ];
}
