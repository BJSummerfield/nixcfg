{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  mkHost =
    valheim:
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        inputs.sops-nix.nixosModules.sops
        ../modules/system/nixos.nix
        ../modules/backups/nixos.nix
        ../modules/valheim-server/nixos.nix
        {
          nixpkgs.hostPlatform = system;
          fileSystems."/" = {
            device = "/dev/null";
            fsType = "ext4";
          };

          mine = {
            system = {
              hostName = "valheim-test";
              externalInterface = "eth0";
              valheim-server = valheim;
            };
            backups = {
              enable = true;
              repository = "s3:example/test";
              repoPasswordFile = "/dev/null";
              b2EnvFile = "/dev/null";
            };
          };
        }
      ];
    }).config;

  base = {
    enable = true;
    worldName = "beefy";
    password = "beefcake";
  };

  host = mkHost base;
  execOf = h: h.containers.valheim.config.systemd.services.valheim.serviceConfig.ExecStart;

  container = host.containers.valheim.config;
  unit = container.systemd.services.valheim;
  update = container.systemd.services.valheim-update;
  env = unit.serviceConfig.Environment;
  exec = unit.serviceConfig.ExecStart;

  # "HOME=/x" -> "/x"
  homeOf = e: lib.removePrefix "HOME=" (lib.head (lib.filter (lib.hasPrefix "HOME=") e));

  seconds =
    s:
    let
      n = lib.toInt (lib.head (builtins.match "([0-9]+).*" s));
    in
    if lib.hasSuffix "min" s then n * 60 else n;

  checks = [
    {
      name = "the saves the server writes are the saves that get backed up";
      ok =
        let
          savesAt = homeOf env;
          hostPath = host.containers.valheim.bindMounts.${savesAt}.hostPath;
        in
        lib.elem hostPath host.mine.backups.paths && lib.elem "valheim" host.mine.backups.stopContainers;
    }
    {
      name = "the refetchable install is bound from the host but kept out of the backup";
      ok =
        let
          installAt = lib.removePrefix "HOME=" (
            lib.head (lib.filter (lib.hasPrefix "HOME=") update.serviceConfig.Environment)
          );
          hostPath = host.containers.valheim.bindMounts.${installAt}.hostPath;
        in
        !(lib.elem hostPath host.mine.backups.paths) && hostPath != null;
    }
    {
      name = "the server runs the binary out of the directory the fetch writes to";
      ok =
        let
          installAt = lib.removePrefix "HOME=" (
            lib.head (lib.filter (lib.hasPrefix "HOME=") update.serviceConfig.Environment)
          );
        in
        lib.hasInfix "-dir ${installAt}" update.serviceConfig.ExecStart
        && lib.hasPrefix "${installAt}/" exec
        && unit.serviceConfig.WorkingDirectory == installAt;
    }
    {
      name = "the binary is made executable, because the steam depot does not flag it";
      ok = lib.hasInfix "chmod +x" (toString update.serviceConfig.ExecStartPost);
    }
    {
      name = "the server only starts once that binary exists";
      ok =
        unit.unitConfig.ConditionPathExists
        == lib.removeSuffix " ${lib.last (lib.splitString " " exec)}" exec
        || lib.hasPrefix unit.unitConfig.ConditionPathExists exec;
    }
    {
      name = "the fetch is off the container's boot path, so a slow download cannot kill it";
      ok =
        !(lib.elem "valheim-update.service" unit.wants)
        && !(lib.elem "valheim-update.service" unit.after)
        && update.wantedBy == [ ]
        && container.systemd.timers.valheim-update.wantedBy == [ "timers.target" ];
    }
    {
      name = "the server is stopped before the fetch, which cannot write a running binary";
      ok =
        lib.hasPrefix "+" update.serviceConfig.ExecStartPre
        && lib.hasInfix "stop valheim.service" update.serviceConfig.ExecStartPre;
    }
    {
      name = "a fetch that fails still brings the server back, rather than leaving it down";
      ok =
        lib.hasPrefix "+" update.serviceConfig.ExecStopPost
        && lib.hasInfix "start valheim.service" update.serviceConfig.ExecStopPost
        && !(lib.hasInfix "valheim.service" (toString update.serviceConfig.ExecStartPost));
    }
    {
      name = "the host waits longer for a stop than the server is allowed to take saving";
      ok =
        seconds host.systemd.services."container@valheim".serviceConfig.TimeoutStopSec
        > seconds unit.serviceConfig.TimeoutStopSec;
    }
    {
      name = "the world is saved on stop, which needs SIGINT rather than SIGTERM";
      ok = unit.serviceConfig.KillSignal == "SIGINT";
    }
    {
      name = "a crash loop cannot become a steam download loop";
      ok =
        unit.serviceConfig.Restart == "on-failure"
        && unit.startLimitBurst > 0
        && unit.startLimitIntervalSec > 0;
    }
    {
      name = "the fetch is scheduled clear of the reboot window and of restic stopping the container";
      ok =
        let
          timer = container.systemd.timers.valheim-update.timerConfig;
          minutes =
            hhmm:
            let
              parts = lib.splitString ":" hhmm;
            in
            lib.toIntBase10 (lib.head parts) * 60 + lib.toIntBase10 (lib.last parts);
          at = minutes timer.OnCalendar;
        in
        # 03:00-05:00 is mine.system.autoUpgrade's reboot window, which can cut
        # a download short; the backup stops the whole container while it runs.
        timer.Persistent
        && !(at >= minutes "03:00" && at <= minutes "05:00")
        && lib.all (b: at > minutes b) host.mine.backups.schedule;
    }
    {
      name = "turning autoUpdate off removes the timer, leaving the fetch manual";
      ok =
        let
          c = (mkHost (base // { autoUpdate = false; })).containers.valheim.config;
        in
        !(c.systemd.timers ? valheim-update) && c.systemd.services ? valheim-update;
    }
    {
      name = "the unit carries nix-ld's paths, which sessionVariables would not give it";
      ok =
        lib.any (lib.hasPrefix "NIX_LD=") env
        && lib.any (lib.hasPrefix "NIX_LD_LIBRARY_PATH=") env
        && container.programs.nix-ld.enable;
    }
    {
      name = "the container takes the next free address pair and nats out through the uplink";
      ok =
        host.containers.valheim.hostAddress == "192.168.100.32"
        && host.containers.valheim.localAddress == "192.168.100.33"
        && lib.elem "ve-valheim" host.networking.nat.internalInterfaces;
    }
    {
      name = "the tailnet is trusted and nothing is forwarded in from the host";
      ok =
        lib.elem "tailscale0" container.networking.firewall.trustedInterfaces
        && host.containers.valheim.forwardPorts == [ ]
        && host.networking.firewall.allowedUDPPorts or [ ] == [ ];
    }
    {
      name = "crossplay is off by default and reaches the command line when asked for";
      ok =
        !(lib.hasInfix "-crossplay" exec)
        && lib.hasInfix "-crossplay" (execOf (mkHost (base // { crossplay = true; })));
    }
    {
      name = "the server is not listed publicly";
      ok = lib.hasInfix "-public 0" exec;
    }
    {
      name = "a null password leaves the flag off entirely";
      ok =
        !(lib.hasInfix "-password" (
          execOf (mkHost {
            enable = true;
          })
        ));
    }
    {
      name = "shell metacharacters in a password survive systemd's own expansion";
      ok =
        let
          e = execOf (mkHost (base // { password = "a$b%c"; }));
        in
        lib.hasInfix "a$$b%%c" e;
    }
    {
      name = "a password inside the server name is refused, not just one inside the world name";
      ok =
        let
          bad = f: !(builtins.tryEval (builtins.seq (mkHost (f base)).system.build.toplevel true)).success;
        in
        bad (b: b // { serverName = "beefcake-server"; })
        && bad (b: b // { worldName = "beefcakeworld"; })
        && bad (b: b // { password = "beef"; });
    }
    {
      name = "no preset or modifier is emitted by default";
      ok = !(lib.hasInfix "-preset" exec) && !(lib.hasInfix "-modifier" exec);
    }
    {
      name = "each set modifier is emitted as its own flag, and null ones are left out";
      ok =
        let
          e = execOf (
            mkHost (
              base
              // {
                modifiers = {
                  deathpenalty = "casual";
                  resources = "more";
                };
              }
            )
          );
        in
        lib.hasInfix "-modifier deathpenalty casual" e
        && lib.hasInfix "-modifier resources more" e
        && !(lib.hasInfix "combat" e)
        && !(lib.hasInfix "raids" e);
    }
    {
      name = "a preset stays ahead of the modifiers it would otherwise overwrite";
      ok =
        let
          e = execOf (
            mkHost (
              base
              // {
                preset = "hard";
                modifiers.resources = "most";
              }
            )
          );
        in
        lib.hasInfix "-preset hard" e
        && lib.hasInfix "-modifier resources most" e
        &&
          lib.stringLength (lib.head (lib.splitString "-preset" e))
          < lib.stringLength (lib.head (lib.splitString "-modifier" e));
    }
    {
      name = "the fetch is anonymous and tracks the default branch until pinned";
      ok =
        let
          pinned =
            (mkHost (base // { branch = "public-test"; }))
            .containers.valheim.config.systemd.services.valheim-update.serviceConfig.ExecStart;
        in
        lib.hasInfix "-app 896660" update.serviceConfig.ExecStart
        && !(lib.hasInfix "-branch" update.serviceConfig.ExecStart)
        && lib.hasInfix "-branch public-test" pinned;
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "valheim-eval-tests" { } (
  if failures == [ ] then
    "touch $out"
  else
    ''
      ${lib.concatMapStringsSep "\n" (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
      exit 1
    ''
)
