{ pkgs, ... }: {
  imports = [
    ./home.nix
    ../common
    ../features
  ];

  features = {
    cli = {
      encode_queue.enable = true;
      helix = {
        bicep.enable = false;
        graphql.enable = false;
        javascript.enable = true;
        # json.enable = true;
        jsx.enable = false;
        markdown.enable = false;
        nix.enable = true;
        rust.enable = false;
        toml.enable = false;
        tsx.enable = false;
        typescript.enable = false;
        yaml.enable = false;
      };
    };

    desktop = {
      hyprland.enable = true;
      firefox.enable = true;
      mako.enable = true;
      wofi.enable = true;
      theme.enable = true;
      keybase.enable = true;
      _1password.enable = true;
    };
  };


  home.packages = with pkgs; [
    steam
    subtitleedit
    makemkv
    yazi
  ];
}
