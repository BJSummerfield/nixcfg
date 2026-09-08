# Bring-up:
#   sudo nixos-container root-login valheim
#   tailscale up --hostname=valheim --advertise-tags=tag:solo-node
#
# Players join from the Valheim client's "Join IP" field, using
# valheim.<tailnet>.ts.net:2456. Crossplay must stay off for that to work.
#
# Roll the server back to an older Steam build after a bad patch:
#   set branch, then nixos-rebuild switch and restart the container.

{
  lib,
  config,
  ...
}:
let
  cfg = config.mine.system.valheim-server;

  mkModifier =
    description: values:
    lib.mkOption {
      type = lib.types.nullOr (lib.types.enum values);
      default = null;
      inherit description;
    };
in
{
  options.mine.system.valheim-server = {
    enable = lib.mkEnableOption "Valheim dedicated server container";

    serverName = lib.mkOption {
      type = lib.types.str;
      default = "paynefield";
      description = "Name shown in the server list. Cosmetic while public is false.";
    };

    worldName = lib.mkOption {
      type = lib.types.str;
      default = "beefy";
      description = ''
        World to load. A world that does not exist yet is generated on first
        start, so changing this and rebuilding starts a fresh world; the old
        one stays on disk under the same save directory and can be returned
        to by setting this back.

        Valheim bakes terrain into the save the first time a zone is visited,
        so a new biome from a game update only appears in ground no player
        has walked on. After a content update, a new world is the only way to
        see the new biome everywhere.
      '';
    };

    password = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        World-readable in the Nix store. Fine for casual use: the server is
        reachable only from the tailnet and is not listed publicly.

        Valheim requires at least 5 characters and refuses to start when the
        password occurs anywhere in the world name.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 2456;
      description = "UDP game port. The query port is always this plus one.";
    };

    crossplay = lib.mkEnableOption ''
      PlayFab crossplay. Consoles can only join with this on, but it routes
      play through Microsoft's relays instead of binding a directly dialable
      UDP socket, which is what breaks joining over Tailscale by address
    '';

    public = lib.mkEnableOption "listing in the public server browser";

    preset = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "normal"
          "casual"
          "easy"
          "hard"
          "hardcore"
          "immersive"
          "hammer"
        ]
      );
      default = null;
      description = ''
        Difficulty preset. Null leaves the world on Valheim's own defaults,
        which is what normal sets anyway.

        Only read while generating a world. A world that already exists keeps
        the settings it was made with, so changing this later does nothing
        until worldName changes too; an admin can still adjust a live world
        from the game console with setworldpreset.
      '';
    };

    modifiers = lib.mkOption {
      type = lib.types.submodule {
        options = {
          combat = mkModifier "How hard enemies hit and how hard they are to kill." [
            "veryeasy"
            "easy"
            "hard"
            "veryhard"
          ];
          deathpenalty = mkModifier "What is lost on death: equipment, and skill progress." [
            "casual"
            "veryeasy"
            "easy"
            "hard"
            "hardcore"
          ];
          resources = mkModifier "How much the world yields when gathered." [
            "muchless"
            "less"
            "more"
            "muchmore"
            "most"
          ];
          raids = mkModifier "How often events attack a base." [
            "none"
            "muchless"
            "less"
            "more"
            "muchmore"
          ];
          portals = mkModifier "What may be carried through a portal." [
            "casual"
            "hard"
            "veryhard"
          ];
        };
      };
      default = { };
      description = ''
        Individual world modifiers. A null category is left at Valheim's own
        default. These are applied after preset, so a preset can be used as a
        base and a category overridden on top of it.

        Read only while generating a world, exactly as preset is.
      '';
    };

    appId = lib.mkOption {
      type = lib.types.str;
      default = "896660";
      description = "Steam app id of the Valheim dedicated server.";
    };

    branch = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Steam branch to download. Null tracks the default public branch.
        Set this to pin the server after a patch breaks it.
      '';
    };

    autoUpdate = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Re-fetch the server build from Steam before every start. Valheim
        refuses connections from clients on a different build, and clients
        update themselves, so tracking the current build is what keeps the
        server joinable.
      '';
    };

    localBackups = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 4;
      description = ''
        Copies kept by Valheim's own save rotation, which writes into the
        directory restic also backs up. Restic only runs nightly, so these
        are what a world is recovered from when it is lost during the day.

        Iron Gate documents the default as 4 and does not say whether 0
        disables rotation outright, so 0 is untested here.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.password == null || builtins.stringLength cfg.password >= 5;
        message = "mine.system.valheim-server.password must be at least 5 characters";
      }
      {
        assertion = cfg.password == null || !(lib.hasInfix cfg.password cfg.worldName);
        message =
          "mine.system.valheim-server.password must not occur in worldName "
          + "(${cfg.worldName}); Valheim refuses to start";
      }
    ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-valheim" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # The game install is refetched from Steam on demand, so only the saves
    # are worth storing.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/valheim-data" ];
      stopContainers = [ "valheim" ];
    };

    system.activationScripts.valheim-dirs = ''
      mkdir -p /var/lib/valheim-data
      chmod 700 /var/lib/valheim-data
      mkdir -p /var/lib/valheim-server
      chmod 700 /var/lib/valheim-server
      mkdir -p /var/lib/tailscale-valheim
      chmod 700 /var/lib/tailscale-valheim
    '';

    containers.valheim = {
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.32";
      localAddress = "192.168.100.33";

      allowedDevices = [
        {
          modifier = "rwm";
          node = "/dev/net/tun";
        }
      ];

      bindMounts = {
        "/var/lib/valheim/home" = {
          hostPath = "/var/lib/valheim-data";
          isReadOnly = false;
        };
        "/var/lib/valheim/server" = {
          hostPath = "/var/lib/valheim-server";
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-valheim";
          isReadOnly = false;
        };
      };

      config =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          install = "/var/lib/valheim/server";
          home = "/var/lib/valheim/home";
          flags = lib.escapeShellArgs (
            # A preset is emitted first because it overwrites every modifier
            # set before it.
            lib.optionals (cfg.preset != null) [
              "-preset"
              cfg.preset
            ]
            ++ [
              "-name"
              cfg.serverName
              "-port"
              (toString cfg.port)
              "-world"
              cfg.worldName
              "-nographics"
              "-batchmode"
              "-public"
              (if cfg.public then "1" else "0")
              "-backups"
              (toString cfg.localBackups)
            ]
            ++ lib.optionals (cfg.password != null) [
              "-password"
              cfg.password
            ]
            ++ lib.concatLists (
              lib.mapAttrsToList (
                category: value:
                lib.optionals (value != null) [
                  "-modifier"
                  category
                  value
                ]
              ) cfg.modifiers
            )
            ++ lib.optional cfg.crossplay "-crossplay"
          );
        in
        {
          # Steam ships an ordinary glibc binary. nix-ld lends it an
          # interpreter in place, so the tree stays byte-identical to the
          # depot and the next fetch has nothing to repair.
          programs.nix-ld.enable = true;

          users.users.valheim = {
            isSystemUser = true;
            group = "valheim";
            inherit home;
          };
          users.groups.valheim = { };

          systemd.tmpfiles.rules = [
            "d ${home} 0700 valheim valheim -"
            "d ${install} 0700 valheim valheim -"
          ];

          systemd.services.valheim-update = lib.mkIf cfg.autoUpdate {
            description = "Fetch the Valheim dedicated server build from Steam";
            serviceConfig = {
              Type = "oneshot";
              User = "valheim";
              Group = "valheim";
              # Steam's scratch state follows HOME, and HOME is the directory
              # restic keeps, so point it at the install tree instead.
              Environment = [ "HOME=${install}" ];
              ExecStart = lib.escapeShellArgs (
                [
                  (lib.getExe pkgs.depotdownloader)
                  "-app"
                  cfg.appId
                  "-osarch"
                  "64"
                  "-dir"
                  install
                  "-validate"
                ]
                ++ lib.optionals (cfg.branch != null) [
                  "-branch"
                  cfg.branch
                ]
              );
              TimeoutStartSec = "30min";
            };
          };

          systemd.services.valheim = {
            description = "Valheim dedicated server";
            wantedBy = [ "multi-user.target" ];
            after = [ "network-online.target" ] ++ lib.optional cfg.autoUpdate "valheim-update.service";
            # Wanted, not required: an unreachable Steam leaves the server on
            # the build already on disk rather than refusing to start.
            wants = [ "network-online.target" ] ++ lib.optional cfg.autoUpdate "valheim-update.service";
            serviceConfig = {
              User = "valheim";
              Group = "valheim";
              WorkingDirectory = install;
              Environment = [
                "HOME=${home}"
                "SteamAppId=892970"
                "NIX_LD=/run/current-system/sw/share/nix-ld/lib/ld.so"
                # nix-ld publishes these through sessionVariables, which a
                # unit does not inherit.
                "NIX_LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib:${install}/linux64"
                "LD_LIBRARY_PATH=${install}/linux64"
              ];
              ExecStart = "${install}/valheim_server.x86_64 ${flags}";
              # Valheim saves on SIGINT and drops the world on SIGTERM.
              KillSignal = "SIGINT";
              TimeoutStopSec = "120";
              Restart = "always";
              RestartSec = "10";
              # World simulation is single threaded.
              Nice = -5;
              PrivateTmp = true;
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/valheim" ];
              NoNewPrivileges = true;
            };
          };

          services.tailscale.enable = true;

          networking = {
            nameservers = [
              "9.9.9.9"
              "1.1.1.1"
            ];
            firewall = {
              enable = true;
              trustedInterfaces = [ "tailscale0" ];
              allowedUDPPorts = [ config.services.tailscale.port ];
            };
          };

          system.stateVersion = "26.05";
        };
    };
  };
}
