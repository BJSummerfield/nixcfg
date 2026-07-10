{ inputs, ... }:
{
  imports = [
    inputs.disko.nixosModules.disko
  ];
  disko.devices = {
    disk = {
      main = {
        type = "disk";
        device = "/dev/disk/by-id/nvme-Samsung_SSD_970_EVO_Plus_500GB_S58SNJ0N611829N";
        content = {
          type = "gpt";
          partitions = {
            ESP = {
              priority = 1;
              size = "512M";
              type = "EF00";
              content = {
                type = "filesystem";
                format = "vfat";
                mountpoint = "/boot";
                mountOptions = [ "umask=0077" ];
              };
            };
            swap = {
              size = "8G";
              content = {
                type = "swap";
                randomEncryption = true;
                discardPolicy = "both";
              };
            };
            root = {
              size = "100%";
              content = {
                type = "luks";
                name = "cryptroot";
                extraOpenArgs = [ "--allow-discards" ];
                settings = {
                  allowDiscards = true;
                };
                content = {
                  type = "filesystem";
                  format = "ext4";
                  mountpoint = "/";
                  mountOptions = [ "noatime" ];
                  extraArgs = [ "-L" "nixos" ];
                };
              };
            };
          };
        };
      };
      media = {
        type = "disk";
        device = "/dev/disk/by-id/ata-Samsung_SSD_860_EVO_250GB_S59WNS0N701502R";
        content = {
          type = "gpt";
          partitions.data = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/media";
              mountOptions = [ "nofail" ];
            };
          };
        };
      };
      games = {
        type = "disk";
        device = "/dev/disk/by-id/ata-Samsung_SSD_850_EVO_500GB_S2RBNX0J305741K";
        content = {
          type = "gpt";
          partitions.data = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/games";
              mountOptions = [ "nofail" ];
            };
          };
        };
      };
      data1 = {
        type = "disk";
        device = "/dev/disk/by-id/ata-WDC_WD20PURX-64PFUY0_WD-WCC4M6NAYY6P";
        content = {
          type = "gpt";
          partitions.data = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/data1";
              mountOptions = [ "nofail" ];
            };
          };
        };
      };
      data2 = {
        type = "disk";
        device = "/dev/disk/by-id/ata-WDC_WD20PURX-64PFUY0_WD-WCC4M5VXCHT3";
        content = {
          type = "gpt";
          partitions.data = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/data2";
              mountOptions = [ "nofail" ];
            };
          };
        };
      };
    };
  };
}
