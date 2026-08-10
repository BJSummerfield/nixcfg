# Pure-evaluation checks for the multi-instance devbox module. No VM here on
# purpose: everything this refactor can break is a value derived from an
# instance's attribute name, and all of those are visible at eval time. The
# parts a VM could uniquely prove — that the tailnet join works, that
# `tailscale serve` publishes — are the manual steps the module deliberately
# keeps out of Nix.
{ nixpkgs, inputs, system }:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  # Only the two modules under test, plus the minimum NixOS needs to evaluate.
  # Deliberately not modules/nixos.nix: importing the whole module set would
  # make this check slow and couple it to modules it is not testing.
  host = (lib.nixosSystem {
    specialArgs = { inherit inputs; };
    modules = [
      ../modules/system/nixos.nix
      ../modules/devbox/nixos.nix
      {
        nixpkgs.hostPlatform = system;
        fileSystems."/" = { device = "/dev/null"; fsType = "ext4"; };

        mine.system = {
          hostName = "devbox-test";
          externalInterface = "eth0";

          devboxes = {
            # Left at the default gitIdentity, to prove the default reaches
            # the container.
            devbox = {
              githubTokenFile = "/run/secrets/devbox-github-token";
              paseoPasswordFile = "/run/secrets/devbox-paseo-password";
              tailnetHostname = "devbox.example.ts.net";
              hostAddress = "192.168.100.26";
              localAddress = "192.168.100.27";
            };
            # Overrides gitIdentity, to prove the override reaches the
            # container and does not leak into the other instance.
            workbox = {
              githubTokenFile = "/run/secrets/workbox-github-token";
              paseoPasswordFile = "/run/secrets/workbox-paseo-password";
              tailnetHostname = "workbox.example.ts.net";
              hostAddress = "192.168.100.28";
              localAddress = "192.168.100.29";
              gitIdentity = {
                name = "Other Person";
                email = "other@example.com";
              };
            };
          };
        };
      }
    ];
  }).config;

  container = name: host.containers.${name};
  gitUser = name: (container name).config.home-manager.users.agent.programs.git.settings.user;

  checks = [
    {
      name = "both containers are defined";
      ok = lib.attrNames host.containers == [ "devbox" "workbox" ];
    }
    {
      name = "each container keeps its own veth addresses";
      ok = (container "devbox").hostAddress == "192.168.100.26"
        && (container "devbox").localAddress == "192.168.100.27"
        && (container "workbox").hostAddress == "192.168.100.28"
        && (container "workbox").localAddress == "192.168.100.29";
    }
    {
      name = "NAT lists every instance's veth";
      ok = lib.sort lib.lessThan host.networking.nat.internalInterfaces
        == [ "ve-devbox" "ve-workbox" ];
    }
    {
      name = "each instance gets its own tailscale state directory";
      ok = lib.elem "d /var/lib/tailscale-devbox 0700 root root -" host.systemd.tmpfiles.rules
        && lib.elem "d /var/lib/tailscale-workbox 0700 root root -" host.systemd.tmpfiles.rules;
    }
    {
      name = "secrets bind-mount per-instance host paths onto shared container paths";
      ok = (container "devbox").bindMounts."/run/secrets/github-token".hostPath
        == "/run/secrets/devbox-github-token"
      && (container "devbox").bindMounts."/run/secrets/paseo-password".hostPath
        == "/run/secrets/devbox-paseo-password"
      && (container "workbox").bindMounts."/run/secrets/github-token".hostPath
        == "/run/secrets/workbox-github-token"
      && (container "workbox").bindMounts."/run/secrets/paseo-password".hostPath
        == "/run/secrets/workbox-paseo-password";
    }
    {
      name = "gitIdentity defaults, and an override applies to one instance only";
      ok = gitUser "devbox" == {
        name = "BJSummerfield";
        email = "brianjsummerfield@gmail.com";
      }
      && gitUser "workbox" == {
        name = "Other Person";
        email = "other@example.com";
      };
    }
    {
      name = "each container is served on its own tailnet hostname";
      ok = (container "devbox").config.services.paseo.hostnames == [ "devbox.example.ts.net" ]
        && (container "workbox").config.services.paseo.hostnames == [ "workbox.example.ts.net" ];
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "devboxes-eval-tests" { } (
  if failures == [ ]
  then "touch $out"
  else ''
    ${lib.concatMapStringsSep "\n"
      (f: "echo 'FAIL: ${f.name}' >&2") failures}
    exit 1
  ''
)
