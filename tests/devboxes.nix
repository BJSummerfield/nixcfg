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
      # modules/system/nixos.nix sets sops.age.sshKeyPaths, so its option
      # tree has to be present even though nothing here decrypts anything.
      inputs.sops-nix.nixosModules.sops
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
              signingKeyFile = "/run/secrets/devbox-signing-key";
              tailnetHostname = "devbox.example.ts.net";
              hostAddress = "192.168.100.26";
              localAddress = "192.168.100.27";
            };
            # Overrides gitIdentity, to prove the override reaches the
            # container and does not leak into the other instance.
            workbox = {
              githubTokenFile = "/run/secrets/workbox-github-token";
              paseoPasswordFile = "/run/secrets/workbox-paseo-password";
              signingKeyFile = "/run/secrets/workbox-signing-key";
              tailnetHostname = "workbox.example.ts.net";
              hostAddress = "192.168.100.28";
              localAddress = "192.168.100.29";
              gitIdentity = {
                name = "Other Person";
                email = "other@example.com";
              };
            };
            # No signing key. Exists only to pin the other branch of the
            # signing gate: getting that branch wrong produces a container
            # whose git refuses to commit at all, which is worse than one
            # that simply does not sign.
            nokey = {
              githubTokenFile = "/run/secrets/nokey-github-token";
              paseoPasswordFile = "/run/secrets/nokey-paseo-password";
              tailnetHostname = "nokey.example.ts.net";
              hostAddress = "192.168.100.30";
              localAddress = "192.168.100.31";
            };
          };
        };
      }
    ];
  }).config;

  container = name: host.containers.${name};
  gitSettings = name: (container name).config.home-manager.users.agent.programs.git.settings;
  gitUser = name: (gitSettings name).user;
  signsCommits = name:
    let settings = gitSettings name; in
    (settings.user.signingkey or null) == "/run/secrets/signing-key"
    && (settings.gpg.format or null) == "ssh"
    && (settings.commit.gpgSign or false) == true
    && (container name).bindMounts ? "/run/secrets/signing-key";

  checks = [
    {
      name = "every instance is defined";
      ok = lib.attrNames host.containers == [ "devbox" "nokey" "workbox" ];
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
        == [ "ve-devbox" "ve-nokey" "ve-workbox" ];
    }
    {
      name = "each instance gets its own tailscale state directory";
      ok = lib.elem "d /var/lib/tailscale-devbox 0700 root root -" host.systemd.tmpfiles.rules
        && lib.elem "d /var/lib/tailscale-workbox 0700 root root -" host.systemd.tmpfiles.rules
        && lib.elem "d /var/lib/tailscale-nokey 0700 root root -" host.systemd.tmpfiles.rules;
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
      ok = (gitUser "devbox").name == "BJSummerfield"
        && (gitUser "devbox").email == "brianjsummerfield@gmail.com"
        && (gitUser "workbox").name == "Other Person"
        && (gitUser "workbox").email == "other@example.com";
    }
    {
      name = "a keyed instance mounts its own key and signs with it";
      ok = signsCommits "devbox"
        && signsCommits "workbox"
        && (container "devbox").bindMounts."/run/secrets/signing-key".hostPath
        == "/run/secrets/devbox-signing-key"
        && (container "workbox").bindMounts."/run/secrets/signing-key".hostPath
        == "/run/secrets/workbox-signing-key";
    }
    {
      # gpgSign left on without a key makes git refuse to commit outright,
      # so all three settings have to disappear together with the mount.
      name = "an unkeyed instance mounts no key and leaves signing off";
      ok = !((container "nokey").bindMounts ? "/run/secrets/signing-key")
        && !((gitUser "nokey") ? signingkey)
        && !((gitSettings "nokey").gpg or { } ? format)
        && !((gitSettings "nokey").commit or { } ? gpgSign);
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
      (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
    exit 1
  ''
)
