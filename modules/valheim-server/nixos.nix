# Bring-up:
#   sudo nixos-container root-login valheim
#   tailscale up --hostname=valheim --advertise-tags=tag:solo-node
#
# First install or repair: valheim-update stages a full copy in the
# background, verifies it, then stops the server only long enough to swap it
# in. Use it for the first install and any time the running build looks
# broken:
#   sudo nixos-container run valheim -- systemctl start valheim-update
# A run started this way stops a timer tick that's in progress first, but if
# one is already mid-download it waits for that download's lock before it
# starts its own.
#
# With autoUpdate on (the default), the same check runs on its own every ten
# minutes; a new build downloads in the background and is swapped in as soon
# as the server is empty, or after forceRestartAfter minutes regardless.
# Status:
#   sudo nixos-container run valheim -- journalctl -u valheim-autoupdate
#   sudo nixos-container run valheim -- cat /var/lib/valheim/server/state/pending
#
# Instant rollback: flip /var/lib/valheim/server/current to point at the
# other slot (slots/a or slots/b) and restart valheim.service by hand. Set
# autoUpdate = false, or pin branch, so the next auto-update doesn't undo it;
# a branch pin is picked up by the next check, within about 10 minutes.
#
# Players join valheim.<tailnet>.ts.net:2456 from the client's Join IP field.

{
  lib,
  config,
  ...
}:
let
  cfg = config.mine.system.valheim-server;
  notifyOn = cfg.notifyUrlFile != null;

  dataDir = "/var/lib/valheim-data";
  serverDir = "/var/lib/valheim-server";
  tailscaleDir = "/var/lib/tailscale-valheim";

  saveTimeout = 120;
  containerStopTimeout = saveTimeout + 60;

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
        Check Steam every 10 minutes and download any new build into a spare
        copy while the server keeps running. Restart onto it as soon as
        nobody is connected, or after forceRestartAfter minutes. Valheim
        refuses clients on a different build, and clients update themselves,
        so this keeps the server joinable. With this off, updates, including
        the first install, happen only through valheim-update.
      '';
    };

    forceRestartAfter = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = ''
        How long a downloaded build waits for the server to empty before the
        restart happens anyway. Clients on the new build can't join until
        then. Counted from the moment the download finished; a container
        restart applies a waiting build immediately.
      '';
    };

    notifyUrlFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Host path to a file holding a Keybase webhookbot URL (e.g.
        config.sops.secrets.keybase-webhook-url.path), bind-mounted
        read-only into the container. When set, joins, leaves, server
        up/down and update progress are posted there. A string rather than
        a path, so a Nix path literal can't copy the secret into the store.
        Null removes the watcher unit and the valheim.service stop hook.
      '';
      example = "/run/secrets/keybase-webhook-url";
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
      paths = [ dataDir ];
      stopContainers = [ "valheim" ];
    };

    systemd.services."container@valheim".serviceConfig.TimeoutStopSec = toString containerStopTimeout;

    system.activationScripts.valheim-dirs = ''
      mkdir -p ${dataDir}
      chmod 700 ${dataDir}
      mkdir -p ${serverDir}
      chmod 700 ${serverDir}
      mkdir -p ${tailscaleDir}
      chmod 700 ${tailscaleDir}
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
          hostPath = dataDir;
          isReadOnly = false;
        };
        "/var/lib/valheim/server" = {
          hostPath = serverDir;
          isReadOnly = false;
        };
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = tailscaleDir;
          isReadOnly = false;
        };
      }
      // lib.optionalAttrs notifyOn {
        "/run/host-secrets/keybase-webhook-url" = {
          hostPath = cfg.notifyUrlFile;
          isReadOnly = true;
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
          exe = "${install}/current/valheim_server.x86_64";
          systemctl = "${config.systemd.package}/bin/systemctl";

          # How often valheim-autoupdate checks Steam for a new build.
          checkCalendar = "*:0/10";
          # Per-phase timeouts (minutes), shared between the units' own
          # TimeoutStartSec and the env vars the script uses for `timeout`
          # and `flock -w`.
          checkTimeoutMin = 10;
          stageTimeoutMin = 45;
          lockWaitMin = 10;

          valheimUpdater = pkgs.writeShellApplication {
            name = "valheim-updater";
            runtimeInputs = [
              pkgs.depotdownloader
              pkgs.coreutils
              pkgs.findutils
              pkgs.gawk
              pkgs.gnugrep
              pkgs.util-linux
              config.systemd.package
            ];
            text = builtins.readFile ./updater.sh;
          };

          # notifyUrlFile is bind-mounted read-only at this fixed path (see
          # bindMounts above).
          sender = pkgs.callPackage ../keybase-notify/package.nix {
            urlFile = "/run/host-secrets/keybase-webhook-url";
          };

          valheimNotify = pkgs.callPackage ./notify-package.nix { };

          # Used by valheim.service's ExecStopPost and by valheim-notify.
          notifyEnvironment = [
            "VALHEIM_INSTALL=${install}"
            "VALHEIM_NOTIFY_SEND=${lib.getExe sender}"
            "VALHEIM_WORLD=${cfg.worldName}"
          ];

          # Shared by valheim-layout, valheim-autoupdate and valheim-update.
          updaterEnvironment = [
            "VALHEIM_INSTALL=${install}"
            "VALHEIM_APP_ID=${cfg.appId}"
            "VALHEIM_BRANCH=${if cfg.branch == null then "" else cfg.branch}"
            "VALHEIM_FORCE_AFTER_MIN=${toString cfg.forceRestartAfter}"
            "VALHEIM_USER=valheim"
            "VALHEIM_CHECK_TIMEOUT_MIN=${toString checkTimeoutMin}"
            "VALHEIM_STAGE_TIMEOUT_MIN=${toString stageTimeoutMin}"
            "VALHEIM_LOCK_WAIT_MIN=${toString lockWaitMin}"
            "VALHEIM_NOTIFY=${if notifyOn then lib.getExe sender else ""}"
          ];

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
            "d ${install}/slots 0700 valheim valheim -"
            "d ${install}/state 0700 valheim valheim -"
          ];

          systemd.services.valheim-layout = {
            description = "Lay out the Valheim install directory";
            wantedBy = [ "multi-user.target" ];
            # Re-running on a rebuild would flip current to a pending slot
            # under a running server, which then never gets restarted onto it.
            restartIfChanged = false;
            before = [
              "valheim.service"
              "valheim-autoupdate.service"
              "valheim-update.service"
            ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
              Environment = updaterEnvironment;
              ExecStart = "${lib.getExe valheimUpdater} layout";
            };
          };

          systemd.services.valheim-autoupdate = {
            description = "Check Steam for a Valheim build update and swap it in when idle";
            requires = [ "valheim-layout.service" ];
            after = [ "valheim-layout.service" ];
            serviceConfig = {
              Type = "oneshot";
              Environment = updaterEnvironment;
              ExecStart = "${lib.getExe valheimUpdater} auto";
              ExecStopPost = "${lib.getExe valheimUpdater} stop-post";
              Nice = 10;
              IOSchedulingClass = "idle";
              TimeoutStartSec = "${toString (checkTimeoutMin + stageTimeoutMin + cfg.forceRestartAfter + 15)}min";
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/valheim" ];
              PrivateTmp = true;
            };
          };

          systemd.timers.valheim-autoupdate = lib.mkIf cfg.autoUpdate {
            wantedBy = [ "timers.target" ];
            timerConfig = {
              OnCalendar = checkCalendar;
            };
          };

          systemd.services.valheim-update = {
            description = "Fetch the Valheim dedicated server build from Steam now";
            requires = [ "valheim-layout.service" ];
            after = [ "valheim-layout.service" ];
            serviceConfig = {
              Type = "oneshot";
              Environment = updaterEnvironment;
              ExecStartPre = "${systemctl} stop valheim-autoupdate.service";
              ExecStart = "${lib.getExe valheimUpdater} now";
              ExecStopPost = "${lib.getExe valheimUpdater} stop-post";
              TimeoutStartSec = "${toString (lockWaitMin + checkTimeoutMin + stageTimeoutMin + 5)}min";
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/valheim" ];
              PrivateTmp = true;
            };
          };

          systemd.services.valheim = {
            description = "Valheim dedicated server";
            wantedBy = [ "multi-user.target" ];
            wants = [ "valheim-layout.service" ];
            after = [ "valheim-layout.service" ] ++ lib.optional notifyOn "network.target";
            unitConfig.ConditionPathExists = exe;
            serviceConfig = {
              User = "valheim";
              Group = "valheim";
              WorkingDirectory = "${install}/current";
              Environment = [
                "HOME=${home}"
                "SteamAppId=892970"
                "NIX_LD=/run/current-system/sw/share/nix-ld/lib/ld.so"
                "NIX_LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib:${install}/current/linux64"
                "LD_LIBRARY_PATH=${install}/current/linux64"
              ]
              ++ lib.optionals notifyOn notifyEnvironment;
              ExecStart = "${exe} ${flags}";
              KillSignal = "SIGINT";
              # 120s to save plus ~25s worst case for a notify post stays
              # comfortably under the container's containerStopTimeout (180s).
              TimeoutStopSec = toString saveTimeout;
              Restart = "on-failure";
              RestartSec = "30";
              Nice = -5;
              PrivateTmp = true;
              ProtectSystem = "strict";
              ReadWritePaths = [ "/var/lib/valheim" ];
              NoNewPrivileges = true;
            }
            // lib.optionalAttrs notifyOn {
              # Every start (including automatic restarts) hands the fresh
              # invocation to a freshly (re)started watcher; `+` runs it as
              # root regardless of this unit's own User=.
              ExecStartPost = "-+${systemctl} restart --no-block valheim-notify.service";
              ExecStopPost = "-+${lib.getExe valheimNotify} stopped";
            };
            startLimitIntervalSec = 600;
            startLimitBurst = 5;
          };

          systemd.services.valheim-notify = lib.mkIf notifyOn {
            description = "Watch the Valheim journal and post join/leave/version events";
            # Deliberately no wantedBy/bindsTo: it is only ever started by
            # valheim.service's ExecStartPost, on every start including
            # restarts, and exits on its own once its invocation is stale.
            after = [ "valheim.service" ];
            serviceConfig = {
              Type = "simple";
              Environment = notifyEnvironment;
              ExecStart = "${lib.getExe valheimNotify} watch";
              Restart = "on-failure";
              RestartSec = 10;
              ProtectSystem = "strict";
              ReadWritePaths = [ "${install}/state" ];
              PrivateTmp = true;
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

          system.stateVersion = "26.11";
        };
    };
  };
}
