{
  lib,
  config,
  inputs,
  ...
}:
let
  inherit (lib) mkOption types;
  cfg = config.mine.users;
  adminUsernames = lib.attrNames (lib.filterAttrs (n: u: u.isSuperUser) cfg);
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
  ];

  options.mine.users = mkOption {
    type = types.attrsOf (
      types.submodule {
        options = {
          isSuperUser = mkOption {
            type = types.bool;
            default = false;
          };
          description = mkOption {
            type = types.str;
            default = "";
          };
          hashedPasswordFile = mkOption { type = types.str; };

          uid = mkOption {
            type = types.nullOr types.int;
            default = null;
            description = ''
              Static uid, identical on every host. Without it NixOS
              allocates uids first-come per machine, so the same user can
              end up with different uids on different hosts - which breaks
              anything keyed on numeric ownership, like the devbox
              container's bind mounts.
            '';
          };

          sshKeys = mkOption {
            type = types.attrsOf types.str;
            default = { };
            description = ''
              Named registry of public SSH keys belonging to this user.
              Keys are not authorized by default. Hosts must opt in via
              authorizedKeys.
            '';
          };

          authorizedKeys = mkOption {
            type = types.listOf types.str;
            default = [ ];
            description = ''
              Names of keys from sshKeys that are authorized to log in as
              this user on this host. Set per-host.
            '';
          };

          shell = mkOption {
            type = types.package;
            default = config.users.defaultUserShell;
          };

          home-modules = mkOption {
            type = types.listOf types.attrs;
            default = [ ];
          };
        };
      }
    );
    default = { };
  };

  config = {
    users.mutableUsers = false;
    nix.settings.trusted-users = [ "root" ] ++ adminUsernames;

    # Make sure there is always at least 1 admin user
    assertions = [
      {
        assertion = lib.any (user: user.isSuperUser) (lib.attrValues cfg);
        message = "DANGER: You are building a system with no Administrator (isSuperUser).";
      }
    ]
    ++ lib.concatLists (
      lib.mapAttrsToList (
        userName: user:
        map (keyName: {
          assertion = lib.hasAttr keyName user.sshKeys;
          message = "User '${userName}' authorizedKeys references unknown key '${keyName}'. Available: ${lib.concatStringsSep ", " (lib.attrNames user.sshKeys)}";
        }) user.authorizedKeys
      ) cfg
    );

    users.users = lib.mapAttrs (name: user: {
      isNormalUser = true;
      inherit (user)
        description
        hashedPasswordFile
        shell
        uid
        ;
      extraGroups = [ "networkmanager" ] ++ lib.optional user.isSuperUser "wheel";
      openssh.authorizedKeys.keys = map (keyName: user.sshKeys.${keyName}) user.authorizedKeys;
    }) cfg;

    # Bridge: propagate per-user mine.allowedUnfree up to system scope so
    # the system-level allowUnfreePredicate sees them - useGlobalPkgs
    # forbids HM modules from writing nixpkgs.config directly.
    mine.allowedUnfree = lib.concatLists (
      lib.mapAttrsToList (userName: userCfg: userCfg.mine.allowedUnfree or [ ]) config.home-manager.users
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
