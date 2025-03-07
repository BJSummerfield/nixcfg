{ pkgs, config, inputs, ... }: {
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
      encoding.enable = true;
    };

    desktop = {
      hyprland.enable = true;
      fonts.enable = true;
    };
  };

  services = {
    keybase.enable = true;
    kbfs.enable = true;
  };

  home.packages = with pkgs; [
    firefox
    steam
    _1password-gui
    _1password
    keybase-gui
    keybase
  ];

  home.sessionVariables = {
    TERMINAL = "ghostty";
  };
}
