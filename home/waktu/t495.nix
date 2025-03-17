{ pkgs, ... }:
{
  imports = [
    ./home.nix
    ../common
    ../features
  ];

  features = {
    desktop = {
      firefox.enable = true;
      hyprland.enable = true;
      mako.enable = true;
      wofi.enable = true;
      theme.enable = true;
      battery.enable = true;
      _1password.enable = true;
      keybase.enable = true;
    };
  };


  home.packages = with pkgs; [
    steam
  ];
}
