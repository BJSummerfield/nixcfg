{ ... }: {
  imports = [
    ./_1password/darwin.nix
    ./alacritty/darwin.nix
    ./firefox/darwin.nix
    ./homebrew/darwin.nix
    ./keybase/darwin.nix
    ./pi-coding-agent/darwin.nix
    ./system/darwin.nix
    ./unfree/darwin.nix
    ./users/darwin.nix
  ];

  home-manager.sharedModules = [
    ./home-darwin.nix
  ];
}
