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
      };
      cli-tools = {
        git.enable = true;
        lazygit.enable = true;
        eza.enable = true;
        direnv.enable = true;
      };
    };
  };
}
