# Bring-up:
#   sudo nixos-container root-login valheim
#   tailscale up --hostname=valheim --advertise-tags=tag:solo-node
#
# Fetch the game now rather than waiting for the timer, which is needed on
# first start and after a patch. The first fetch is about 1.6 GB, and the
# server is stopped for the duration and started again at the end:
#   sudo nixos-container run valheim -- systemctl start valheim-update
#
# Roll back to an older Steam build: set branch, nixos-rebuild switch, then
# run the fetch above.
#
# Players join valheim.<tailnet>.ts.net:2456 from the client's Join IP field.

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
        World-readable in the Nix store, and visible in the server's argv.
        Fine for casual use: the server is reachable only from the tailnet
        and is not listed publicly.

        Valheim requires at least 5 characters and refuses to start when the
        password occurs in either the server name or the world name.
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
        Refetch the server build shortly after boot and once a day. Valheim
        refuses connections from clients on a different build, and clients
        update themselves, so tracking the current build is what keeps the
        server joinable.

        The fetch deliberately does not gate startup: the server comes up on
        whatever build is already on disk. The fetch itself stops the server
        for its duration, because the download overwrites the running binary,
        and starts it again at the end whether or not it succeeded. With this
        off, the game has to be fetched by hand before the server can start
        at all.
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
        assertion =
          cfg.password == null
          || !(lib.hasInfix cfg.password cfg.worldName || lib.hasInfix cfg.password cfg.serverName);
        message =
          "mine.system.valheim-server.password must not occur in worldName "
          + "(${cfg.worldName}) or serverName (${cfg.serverName}); Valheim refuses to start";
      }
    ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-valheim" ];
      externalInterface = config.mine.system.externalInterface;
    };

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/valheim-data" ];
      stopContainers = [ "valheim" ];
    };

    systemd.services."container@valheim".serviceConfig.TimeoutStopSec = "180";

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
          exe = "${install}/valheim_server.x86_64";
          systemctl = "${config.systemd.package}/bin/systemctl";
          flags = builtins.replaceStrings [ "$" "%" ] [ "$$" "%%" ] (
            lib.escapeShellArgs (
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
            )
          );
        in
        {
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

          # 06:30 is the first quiet slot of the morning: past the 03:00-05:00
          # auto-upgrade reboot window, and past 05:15 restic, which stops this
          # whole container for the length of its run. Persistent catches a run
          # up when the box was down for it, so no boot-time firing is needed.
          systemd.timers.valheim-update = lib.mkIf cfg.autoUpdate {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnCalendar = "06:30";
              Persistent = true;
            };
          };

          systemd.services.valheim-update = {
            description = "Fetch the Valheim dedicated server build from Steam";
            serviceConfig = {
              Type = "oneshot";
              User = "valheim";
              Group = "valheim";
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
              # The download writes over the very binary the server is
              # executing, which the kernel refuses with ETXTBSY, so the server
              # has to be down for it. Coming back up is ExecStopPost rather
              # than ExecStartPost because that runs on a failed fetch too: a
              # Steam outage must not leave the world offline until someone
              # notices.
              ExecStartPre = "+${systemctl} stop valheim.service";
              ExecStartPost = "${pkgs.coreutils}/bin/chmod +x ${exe}";
              ExecStopPost = "+${systemctl} start valheim.service";
              TimeoutStartSec = "30min";
            };
          };

          systemd.services.valheim = {
            description = "Valheim dedicated server";
            wantedBy = [ "multi-user.target" ];
            unitConfig.ConditionPathExists = exe;
            serviceConfig = {
              User = "valheim";
              Group = "valheim";
              WorkingDirectory = install;
              Environment = [
                "HOME=${home}"
                "SteamAppId=892970"
                "NIX_LD=/run/current-system/sw/share/nix-ld/lib/ld.so"
                "NIX_LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib:${install}/linux64"
                "LD_LIBRARY_PATH=${install}/linux64"
              ];
              ExecStart = "${exe} ${flags}";
              KillSignal = "SIGINT";
              TimeoutStopSec = "120";
              Restart = "on-failure";
              RestartSec = "30";
              Nice = -5;
              PrivateTmp = true;
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/valheim" ];
              NoNewPrivileges = true;
            };
            startLimitIntervalSec = 600;
            startLimitBurst = 5;
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

          system.stateVersion = "26.11";
        };
    };
  };
}
