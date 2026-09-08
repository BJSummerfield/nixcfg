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
    mine.allowedUnfree = lib.concatLists (
      lib.mapAttrsToList (_userName: userCfg: userCfg.mine.allowedUnfree or [ ]) config.home-manager.users
    );

    home-manager = {
      useGlobalPkgs = true;
      useUserPackages = true;
      extraSpecialArgs = { inherit inputs; };
    };
  };
}
