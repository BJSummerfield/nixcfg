{ config, ... }: {
  imports = [
    ./home.nix
    ../common
    ../features/cli
    ../features/desktop
  ];

  features = {
    cli = {
      fish.enable = true;
      helix.enable = true;
      git.enable = true;
      ssh-1password.enable = true;
    };

    desktop = {
      hyprland.enable = false;
      wayland.enable = false;
      fonts.enable = true;
    };
  };

  programs.ghostty = {
    settings = {
      font-size = 12;
    };
  };
}
