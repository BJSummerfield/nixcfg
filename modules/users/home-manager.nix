# Wires each mine.accounts.<name> up to home-manager: one profile per
# account, plus the allowedUnfree bridge home-manager's useGlobalPkgs needs.
{
  lib,
  config,
  inputs,
  ...
}:
let
  cfg = config.mine.accounts;
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
  ];

  config = {
    # Bridge: propagate per-user mine.allowedUnfree up to system scope
    # so the system-level allowUnfreePredicate sees them. Required because
    # home-manager.useGlobalPkgs = true forbids HM modules from writing
    # nixpkgs.config directly.
    mine.allowedUnfree = lib.concatLists (
      lib.mapAttrsToList (_userName: userCfg: userCfg.mine.allowedUnfree or [ ]) config.home-manager.users
    );

    home-manager = {
      useGlobalPkgs = true;
      useUserPackages = true;
      extraSpecialArgs = {
        inherit inputs;
        systemCfg = config.mine.system;
      };
      users = lib.mapAttrs (name: user: {
        imports = user.home-modules ++ [
          {
            home.username = name;
            home.homeDirectory = "/home/${name}";
            home.stateVersion = "26.05";
          }
        ];
      }) cfg;
    };
  };
}
