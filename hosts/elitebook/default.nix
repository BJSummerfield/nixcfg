{ pkgs, ... }:
let
  waktuProfile = import ../../users/waktu.nix;
  dummyProfile = import ../../users/dummy.nix;
in
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
      ../../users
    ];

  config = {
    mine = {
      system = {
        hostName = "elitebook";
        openssh.enable = true;
        shell.fish.enable = true;
      };
      cli-tools = {
        tailscale.enable = true;
      };
      users = {
        "waktu" = waktuProfile {
          inherit pkgs;
          modules = [
            {
              mine = {
                user = {
                  git.enable = true;
                  lazygit.enable = true;
                };
              };
            }
          ];
        };
        "dummy" = dummyProfile {
          inherit pkgs;
          modules = [
            {
              mine = {
                user = {
                  git.enable = true;
                  # lazygit.enable = true;
                };
              };
            }
          ];
        };
      };
    };
  };
}
