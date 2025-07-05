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
        fonts.enable = true;
        ssh = {
          enable = true;
        };
      };
      desktop = {
        niri.enable = true;
        fuzzel.enable = true;
        swaybg.enable = true;
      };
      apps = {
        alacritty.enable = true;
        firefox.enable = true;
      };
      cli-tools = {
        direnv.enable = true;
        eza.enable = true;
        git.enable = true;
        lazygit.enable = true;
        starship.enable = true;
        zoxide.enable = true;
        helix = {
          enable = true;
          lsp = {
            nix.enable = true;
          };
        };
      };
    };
  };
}
