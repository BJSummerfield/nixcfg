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

  host = mkHost {
    enable = true;
    worldName = "beefy";
    password = "beefcake";
  };

  crossplayHost = mkHost {
    enable = true;
    worldName = "beefy";
    crossplay = true;
  };

  container = host.containers.valheim.config;
  unit = container.systemd.services.valheim;
  update = container.systemd.services.valheim-update;
  env = unit.serviceConfig.Environment;

  paynefield = inputs.self.nixosConfigurations.paynefield.config;

  checks = [
    {
      name = "the container takes the next free address pair on the container lan";
      ok =
        host.containers.valheim.hostAddress == "192.168.100.32"
        && host.containers.valheim.localAddress == "192.168.100.33";
    }
    {
      name = "the container's interface is natted out through the host uplink";
      ok =
        lib.elem "ve-valheim" host.networking.nat.internalInterfaces
        && host.networking.nat.externalInterface == "eth0";
    }
    {
      name = "saves are bound from the host and the refetchable install is kept apart";
      ok =
        host.containers.valheim.bindMounts."/var/lib/valheim/home".hostPath == "/var/lib/valheim-data"
        &&
          host.containers.valheim.bindMounts."/var/lib/valheim/server".hostPath == "/var/lib/valheim-server"
        && host.containers.valheim.bindMounts."/var/lib/tailscale".hostPath == "/var/lib/tailscale-valheim";
    }
    {
      name = "only the saves are backed up, and the container is stopped for a clean copy";
      ok =
        lib.elem "/var/lib/valheim-data" host.mine.backups.paths
        && !(lib.elem "/var/lib/valheim-server" host.mine.backups.paths)
        && lib.elem "valheim" host.mine.backups.stopContainers;
    }
    {
      name = "the tailnet is trusted and nothing is forwarded in from the host";
      ok =
        lib.elem "tailscale0" container.networking.firewall.trustedInterfaces
        && host.containers.valheim.forwardPorts == [ ];
    }
    {
      name = "crossplay is off by default, so the server binds a dialable socket";
      ok = !(lib.hasInfix "-crossplay" unit.serviceConfig.ExecStart);
    }
    {
      name = "turning crossplay on does reach the command line";
      ok = lib.hasInfix "-crossplay" crossplayHost.containers.valheim.config.systemd.services.valheim.serviceConfig.ExecStart;
    }
    {
      name = "the server is not listed publicly and keeps valheim's own save rotation";
      ok =
        lib.hasInfix "-public 0" unit.serviceConfig.ExecStart
        && lib.hasInfix "-backups 4" unit.serviceConfig.ExecStart;
    }
    {
      name = "a null password leaves the flag off entirely";
      ok =
        !(lib.hasInfix "-password"
          (mkHost {
            enable = true;
            worldName = "beefy";
          }).containers.valheim.config.systemd.services.valheim.serviceConfig.ExecStart
        );
    }
    {
      name = "no preset is emitted by default, leaving the world on valheim's own balance";
      ok = !(lib.hasInfix "-preset" unit.serviceConfig.ExecStart);
    }
    {
      name = "a preset is emitted ahead of everything it would otherwise overwrite";
      ok =
        lib.hasPrefix "/var/lib/valheim/server/valheim_server.x86_64 -preset hard"
          (mkHost {
            enable = true;
            worldName = "beefy";
            preset = "hard";
          }).containers.valheim.config.systemd.services.valheim.serviceConfig.ExecStart;
    }
    {
      name = "no modifier is emitted by default";
      ok = !(lib.hasInfix "-modifier" unit.serviceConfig.ExecStart);
    }
    {
      name = "each set modifier is emitted as its own flag, and null ones are left out";
      ok =
        let
          exec =
            (mkHost {
              enable = true;
              worldName = "beefy";
              modifiers = {
                deathpenalty = "casual";
                resources = "more";
              };
            }).containers.valheim.config.systemd.services.valheim.serviceConfig.ExecStart;
        in
        lib.hasInfix "-modifier deathpenalty casual" exec
        && lib.hasInfix "-modifier resources more" exec
        && !(lib.hasInfix "combat" exec)
        && !(lib.hasInfix "raids" exec)
        && !(lib.hasInfix "portals" exec);
    }
    {
      name = "a preset stays ahead of the modifiers it would otherwise overwrite";
      ok =
        let
          exec =
            (mkHost {
              enable = true;
              worldName = "beefy";
              preset = "hard";
              modifiers.resources = "most";
            }).containers.valheim.config.systemd.services.valheim.serviceConfig.ExecStart;
        in
        lib.hasInfix "-preset hard" exec
        && lib.hasInfix "-modifier resources most" exec
        &&
          (lib.stringLength (lib.head (lib.splitString "-preset" exec)))
          < (lib.stringLength (lib.head (lib.splitString "-modifier" exec)));
    }
    {
      name = "the world is saved on stop, which needs SIGINT rather than SIGTERM";
      ok = unit.serviceConfig.KillSignal == "SIGINT";
    }
    {
      name = "the unit carries nix-ld's paths, which sessionVariables would not give it";
      ok =
        lib.any (lib.hasPrefix "NIX_LD=") env
        && lib.any (lib.hasPrefix "NIX_LD_LIBRARY_PATH=") env
        && container.programs.nix-ld.enable;
    }
    {
      name = "saves land in the bound home, while steam's scratch state stays in the install";
      ok =
        lib.elem "HOME=/var/lib/valheim/home" env
        && lib.elem "HOME=/var/lib/valheim/server" update.serviceConfig.Environment;
    }
    {
      name = "a failed fetch leaves the server on the build already on disk";
      ok =
        lib.elem "valheim-update.service" unit.wants
        && !(lib.elem "valheim-update.service" (unit.requires or [ ]));
    }
    {
      name = "the fetch is anonymous and tracks the default branch until pinned";
      ok =
        lib.hasInfix "-app 896660" update.serviceConfig.ExecStart
        && !(lib.hasInfix "-username" update.serviceConfig.ExecStart)
        && !(lib.hasInfix "-branch" update.serviceConfig.ExecStart);
    }
    {
      name = "setting a branch pins the fetch";
      ok =
        lib.hasInfix "-branch public-test"
          (mkHost {
            enable = true;
            worldName = "beefy";
            branch = "public-test";
          }).containers.valheim.config.systemd.services.valheim-update.serviceConfig.ExecStart;
    }
    {
      name = "paynefield runs the world it means to, with a password valheim will accept";
      ok =
        paynefield.mine.system.valheim-server.worldName == "beefy"
        && paynefield.mine.system.valheim-server.password == "beefcake"
        && !paynefield.mine.system.valheim-server.crossplay;
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
