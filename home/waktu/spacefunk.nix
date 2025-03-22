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
        bicep.enable = true;
        graphql.enable = true;
        javascript.enable = true;
        json.enable = true;
        jsx.enable = true;
        markdown.enable = true;
        nix.enable = true;
        rust.enable = true;
        toml.enable = true;
        tsx.enable = true;
        typescript.enable = true;
        yaml.enable = true;
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
