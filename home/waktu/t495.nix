{ pkgs, ... }:
{
  imports = [
    ./home.nix
    ../common
    ../features
  ];

  features = {
    cli = {
      encode_queue.enable = true;
    };

    desktop = {
      hyprland.enable = true;
      battery.enable = true;
      _1password.enable = true;
      keybase.enable = true;
    };
  };


  home.packages = with pkgs; [
    firefox
    steam
    subtitleedit
    makemkv
  ];
}
