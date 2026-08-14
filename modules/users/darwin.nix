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
    # Bridge: propagate per-user mine.allowedUnfree up to system scope,
    # same as users/nixos.nix. Required because useGlobalPkgs forbids HM
    # modules from writing nixpkgs.config directly.
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
