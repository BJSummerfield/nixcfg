{ pkgs, config, inputs, ... }: {
  imports = [
    ./home.nix
    ../common
    ../features/cli
    ../features/desktop
    inputs.catppuccin.homeManagerModules.catppuccin
  ];

  catppuccin = {
    flavor = "mocha";
    starship.enable = true;
    fish.enable = true;
    lazygit.enable = true;
    rofi = {
      enable = true;
      flavor = "macchiato";
    };
    mako = {
      enable = true;
      flavor = "macchiato";
    };
    bottom.enable = true;
  };

  features = {
    cli = {
      fish.enable = true;
      helix.enable = true;
      git.enable = true;
      ssh-1password.enable = true;
    };

    desktop = {
      hyprland.enable = true;
      fonts.enable = true;
    };
  };

  programs.ghostty = {
    settings = {
      font-size = 12;
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
    EDITOR = "hx";
    TERMINAL = "ghostty";
  };
}
