{ ... }:
{
  imports =
    [
      ./hardware-configuration.nix
      ../../modules
    ];

  config = {
    mine = {
      system = {
        hostName = "t495";
        bootPartitionUuid = "5cccbb79-6ae4-4a43-add1-9b5fa0a03e18";
        ssh = {
          enable = true;
          authorizedKeys = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtTarFZkhNoHtu39C6eCRaS84jb6SPoY92gn64Q2D3O";
        };
      };
      cli-tools = {
        direnv.enable = true;
        eza.enable = true;
        git.enable = true;
        lazygit.enable = true;
        starship.enable = true;
        zoxide.enable = true;
      };
    };
  };
}
