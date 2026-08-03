{ inputs, ... }: {
  imports = [
    inputs.mac-app-util.darwinModules.default
    ./_1password/darwin.nix
    ./firefox/darwin.nix
    ./homebrew/darwin.nix
    ./keybase/darwin.nix
    ./coding-agents/darwin.nix
    ./system/darwin.nix
    ./theme/darwin.nix
    ./unfree/darwin.nix
    ./users/darwin.nix
  ];

  home-manager.sharedModules = [
    ./home-darwin.nix
    inputs.mac-app-util.homeManagerModules.default
  ];
}
