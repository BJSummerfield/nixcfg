{ pkgs, ... }:
{
  imports = [
    ./disko.nix
    ../../modules/nixos.nix
    ../../users/waktu.nix
    ../../users/sumriri.nix
    ../../users/sword.nix
    ../../users/jellyuser.nix
  ];

  nixpkgs.hostPlatform = "x86_64-linux";
  hardware.enableRedistributableFirmware = true;
  hardware.cpu.intel.updateMicrocode = true;
  boot.initrd.availableKernelModules = [
    "xhci_pci"
    "thunderbolt"
    "vmd"
    "nvme"
    "usb_storage"
    "sd_mod"
  ];
  boot.kernelModules = [ "kvm-intel" ];

  environment.systemPackages = with pkgs; [
    bottom
    git
    helix
  ];

  environment.etc."wireplumber/wireplumber.conf.d/51-default-volume.conf".text = ''
    wireplumber.settings = {
      device.routes.default-sink-volume = 0.8
      device.routes.default-source-volume = 0.8
    }
  '';

  environment.etc."wireplumber/wireplumber.conf.d/52-prefer-hdmi.conf".text = ''
    monitor.alsa.rules = [
      {
        matches = [
          { node.name = "alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__HDMI1__sink" }
        ]
        actions = {
          update-props = {
            priority.session = 3000
            priority.driver = 3000
          }
        }
      }
    ]
  '';

  mine = {
    system = {
      hostName = "elitebook";
      externalInterface = "wlp0s20f3";
      renderGroupGid = 303;
      autoUpgrade.enable = true;
      fish.enable = true;
      jellybox.enable = true;
      steam.enable = true;
      steambox.enable = true;
      pipewire.enable = true;
      remoteAccess = {
        enable = true;
        lanAccess = true;
      };
    };
  };
  home-manager.users = {
    waktu = {
      mine.user = {
        fish.enable = true;
        fuzzel.enable = true;
        helix = {
          enable = true;
          lsp = {
            css.enable = true;
            html.enable = true;
            javascript.enable = true;
            json.enable = true;
            jsx.enable = true;
            markdown.enable = true;
            nix.enable = true;
            rust.enable = true;
            toml.enable = true;
            tsx.enable = true;
            typescript.enable = true;
            yaml.enable = true;
          };
        };
      };
      programs = {
        eza.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
    sumriri.mine.user.steambox.autoStart.enable = true;
    sword.mine.user.steambox.autoStart.enable = true;
  };
}
