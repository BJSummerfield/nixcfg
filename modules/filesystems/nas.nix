{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkOption mkIf mkMerge types
    mapAttrs' mapAttrsToList filterAttrs optionalAttrs;
  cfg = config.mine.system.nas;
  enabledShares = filterAttrs (_: s: s.enable) cfg.shares;
  hasEnabledShares = enabledShares != { };
  usersCfg = config.mine.users;
in
{
  options.mine.system.nas = {
    host = mkOption {
      type = types.str;
      default = "192.168.1.234";
    };

    shares = mkOption {
      type = types.attrsOf (types.submodule ({ name, ... }: {
        options = {
          enable = mkEnableOption "Mount this share";
          remotePath = mkOption {
            type = types.str;
            default = "/volume1/${name}";
          };
          mountPoint = mkOption {
            type = types.str;
            default = "/mnt/secure/nas/${name}";
          };
          persistent = mkOption {
            type = types.bool;
            default = false;
            description = "Keep mount alive permanently (for servers/containers)";
          };
          rwGid = mkOption {
            type = types.nullOr types.int;
            default = null;
            description = "GID for read-write access group";
          };
          roGid = mkOption {
            type = types.nullOr types.int;
            default = null;
            description = "GID for read-only access group";
          };
        };
      }));
      default = {
        media = {
          roGid = 65540;
          rwGid = 65541;
        };
        data = { };
      };
    };
  };

  options.mine.users = mkOption {
    type = types.attrsOf (types.submodule {
      options.nasAccess = mkOption {
        type = types.attrsOf (types.enum [ "ro" "rw" ]);
        default = { };
        description = "Per-share NAS access level";
      };
    });
  };

  config = mkIf hasEnabledShares {
    boot.supportedFilesystems = [ "nfs" ];
    services.rpcbind.enable = true;

    users.groups = mkMerge (mapAttrsToList
      (name: share:
        optionalAttrs (share.rwGid != null)
          {
            "${name}-rw".gid = share.rwGid;
          } // optionalAttrs (share.roGid != null) {
          "${name}-ro".gid = share.roGid;
        }
      )
      enabledShares);

    users.users = lib.mapAttrs
      (username: user:
        let
          access = user.nasAccess;
          groups = lib.concatLists (mapAttrsToList
            (shareName: level:
              let share = cfg.shares.${shareName} or null; in
              if share == null then [ ]
              else if level == "rw" && share.rwGid != null then [ "${shareName}-rw" ]
              else if level == "ro" && share.roGid != null then [ "${shareName}-ro" ]
              else [ ]
            )
            access);
        in
        optionalAttrs (groups != [ ]) {
          extraGroups = groups;
        }
      )
      usersCfg;

    assertions =
      lib.concatLists
        (mapAttrsToList
          (username: user:
            mapAttrsToList
              (shareName: level: {
                assertion = cfg.shares ? ${shareName};
                message = "User ${username} has nasAccess for '${shareName}' but that share is not defined in mine.system.nas.shares";
              })
              user.nasAccess
          )
          usersCfg) ++
      lib.concatLists (mapAttrsToList
        (username: user:
          mapAttrsToList
            (shareName: level:
              let share = cfg.shares.${shareName} or { rwGid = null; roGid = null; }; in
              {
                assertion =
                  (level == "rw" -> share.rwGid != null) &&
                  (level == "ro" -> share.roGid != null);
                message = "User ${username} has nasAccess.${shareName} = \"${level}\" but that share has no ${level}Gid defined";
              }
            )
            user.nasAccess
        )
        usersCfg);

    fileSystems = mapAttrs'
      (_: share: {
        name = share.mountPoint;
        value = {
          device = "${cfg.host}:${share.remotePath}";
          fsType = "nfs";
          options = [
            "x-systemd.automount"
            "noauto"
            "nfsvers=3"
            "timeo=150"
          ] ++ (if share.persistent then [
            "hard"
            "retrans=5"
          ] else [
            "soft"
            "x-systemd.idle-timeout=600"
            "retrans=2"
          ]);
        };
      })
      enabledShares;

    home-manager.sharedModules = [{
      home.file."nas".source =
        config.lib.file.mkOutOfStoreSymlink "/mnt/secure/nas";
    }];
  };
}
