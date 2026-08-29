{
  lib,
  config,
  inputs,
  ...
}:
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
  ];

  config = {
    # Bridge: propagate per-user mine.allowedUnfree to system scope, as in
    # users/nixos.nix - useGlobalPkgs forbids HM modules writing nixpkgs.config.
    mine.allowedUnfree = lib.concatLists (
      lib.mapAttrsToList (userName: userCfg: userCfg.mine.allowedUnfree or [ ]) config.home-manager.users
    );

    home-manager = {
      useGlobalPkgs = true;
      useUserPackages = true;
      extraSpecialArgs = { inherit inputs; };
    };
  };
}
