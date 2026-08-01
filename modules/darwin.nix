{ ... }: {
  imports = [
    ./homebrew/darwin.nix
    ./pi-coding-agent/darwin.nix
    ./system/darwin.nix
    ./unfree/darwin.nix
    ./users/darwin.nix
  ];

  home-manager.sharedModules = [
    ./home-darwin.nix
  ];
}
