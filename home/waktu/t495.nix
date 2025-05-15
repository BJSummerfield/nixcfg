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
      xdg-desktop-portal-gnome
      xdg-desktop-portal-gtk
      # xdg-desktop-portal-wlr
    ];
    config.common.default = [
      "gnome"
      # "hyprland"
      "gtk"
      # "wlr"
    ];
  };

  home.packages = with pkgs; [
    # brightnessctl
    # grim
    # slurp
    wl-clipboard
    xwayland-satellite
  ];

  programs.niri.enable = true;

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
      obs-studio.enable = true;
      theme.enable = true;
    };
  };
}
