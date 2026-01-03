{ lib, config, pkgs, inputs, ... }:
let
  inherit (lib) mkOption types;
  cfg = config.mine.users;
  adminUsernames = lib.attrNames (lib.filterAttrs (n: u: u.isSuperUser) cfg);
in
{

  # Import home manager
  imports = [
    inputs.home-manager.nixosModules.home-manager
  ];

  options.mine.users = mkOption {
    type = types.attrsOf (types.submodule {
      options = {
        isSuperUser = mkOption { type = types.bool; default = false; };
        description = mkOption { type = types.str; };
        initialHashedPassword = mkOption { type = types.str; default = ""; };
        sshKeys = mkOption { type = types.listOf types.str; default = [ ]; };
        shell = mkOption { type = types.package; default = pkgs.fish; };

        home-modules = mkOption {
          type = types.listOf types.attrs;
          default = [ ];
        };
      };
    });
    default = { };
  };

  config = {
    # Allow admins to use nix
    nix.settings.trusted-users = [ ] ++ adminUsernames;

    # Make sure there is always at least 1 admin user
    assertions = [
      {
        assertion = lib.any (user: user.isSuperUser) (lib.attrValues cfg);
        message = "DANGER: You are building a system with no Administrator (isSuperUser). You will be locked out of sudo!";
      }
    ];

    # Map the users to some defaults
    users.users = lib.mapAttrs
      (name: user: {
        isNormalUser = true;
        inherit (user) description initialHashedPassword shell;
        extraGroups = [ "networkmanager" ] ++ lib.optional user.isSuperUser "wheel";
        openssh.authorizedKeys.keys = user.sshKeys;
      })
      cfg;

    # Map the users to home-manager
    home-manager = {
      useUserPackages = true;
      extraSpecialArgs = { inherit inputs; };
      users = lib.mapAttrs
        (name: user: {
          imports = user.home-modules ++ [
            {
              home.username = name;
              home.homeDirectory = "/home/${name}";
              home.stateVersion = "24.05";
            }
          ];
        })
        cfg;
    };
  };
}
