{ pkgs, ... }:
{
  imports = [
    ./home.nix
    ../common
    ../features
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
      hyprland.enable = true;
      keybase.enable = true;
      mako.enable = true;
      theme.enable = true;
      # wofi.enable = true;
      fuzzel.enable = true;
    };
  };


  home.packages = with pkgs; [
    steam
  ];
}
