{ pkgs, ... }:
{
  imports = [
    ./home.nix
    ../common
    ../features
  ];

  xdg.portal = {
    enable = true;
    extraPortals = with pkgs; [
      # xdg-desktop-portal-hyprland
      xdg-desktop-portal-gtk
    ];
    config.common.default = [
      # "hyprland"
      "gtk"
    ];
  };

  home.packages = with pkgs; [
    brightnessctl
    grim
    slurp
    wl-clipboard
    xwayland-satellite
  ];

  features = {

    cli = {
      helix = {
        # bicep.enable = true;
        # graphql.enable = true;
        # javascript.enable = true;
        json.enable = true;
        # jsx.enable = true;
        markdown.enable = true;
        nix.enable = true;
        rust.enable = true;
        toml.enable = true;
        # tsx.enable = true;
        # typescript.enable = true;
        yaml.enable = true;
      };
    };

    desktop = {
      _1password.enable = true;
      battery.enable = true;
      firefox.enable = true;
      fuzzel.enable = true;
      # hypridle.enable = true;
      # hyprland.enable = true;
      # hyprlock.enable = true;
      # hyprpolkitagent.enable = true;
      keybase.enable = true;
      mako.enable = true;
      theme.enable = true;
    };
  };
}
