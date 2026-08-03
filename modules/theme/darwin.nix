# Provide themeConstants to home-manager on darwin.
# Mirrors the nixos setup; darwin uses the unmodified constants directly.
{ pkgs, ... }:
let
  themeConstants = import ./constants.nix;
in
{
  home-manager.extraSpecialArgs = {
    inherit themeConstants;
  };

  home-manager.sharedModules = [
    ./home.nix
  ];
}
