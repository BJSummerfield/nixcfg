# Persistent coding-agent containers. Security boundary: ssh/sops/signing keys
# stay on the host and are bind-mounted read-only onto the same three paths
# inside every container (/run/secrets/{github-token,paseo-password,signing-key});
# no secret ever enters a container's filesystem or the nix store. Repos live
# in the container filesystem — GitHub holds the code.
#
# Each attribute of mine.system.devboxes is one container. Once an instance is
# running, join the tailnet and publish paseo once, substituting its attribute
# name for <name>:
# sudo nixos-container root-login <name>
# tailscale up --hostname=<name> --advertise-tags=tag:devbox
# tailscale serve --bg 6767
#
# Reusing tag:devbox across instances keeps one set of tailnet ACLs; a distinct
# tag per instance would need ACL edits on the Tailscale side.
#
# Both are one-time. /var/lib/tailscale is bind-mounted to
# /var/lib/tailscale-<name> on the host, so the node identity and the serve
# config survive container restarts and rebuilds; you only redo this if
# that host directory is wiped. Manual tailscale join — more reliable than
# declarative on nspawn containers.
{
  config,
  lib,
  inputs,
  ...
}:
let
  inherit (lib)
    mapAttrs
    mapAttrsToList
    mkIf
    mkMerge
    mkOption
    types
    ;
  cfg = config.mine.system.devboxes;
  # Every container on this host, not just devboxes: containers.<name> is the
  # same builtin option every container-backed module (jellyfin-server,
  # stalwart-server, photoform, this one, ...) writes hostAddress/localAddress
  # into, so reading it back here catches a collision regardless of which
  # module introduced it.
  allContainerAddresses = lib.concatMap (
    c:
    (lib.optional (c.hostAddress or null != null) c.hostAddress)
    ++ (lib.optional (c.localAddress or null != null) c.localAddress)
  ) (lib.attrValues config.containers);
in
{
  options.mine.system.devboxes = mkOption {
    default = { };
    description = ''
      Coding-agent containers, keyed by container name. Presence in this
      attrset is what enables a container - there is no separate enable
      flag, matching how `containers.*` itself reads.

      Multiple instances typically exist to hold different credentials rather
      than different code - e.g. two containers distinguished only by which
      GitHub token each one decrypts.
    '';
    example = lib.literalExpression ''
      {
        devbox = {
          githubTokenFile = config.sops.secrets.devbox-github-token.path;
          paseoPasswordFile = config.sops.secrets.devbox-paseo-password.path;
          tailnetHostname = "devbox.mist-gamma.ts.net";
          hostAddress = "192.168.100.26";
          localAddress = "192.168.100.27";
        };
      }
    '';
    type = types.attrsOf (
      types.submodule {
        options = {
          githubTokenFile = mkOption {
            type = types.path;
            description = ''
              Path on the host to a file containing only a GitHub fine-grained
              PAT, scoped to an explicit repository allowlist with Contents and
              Pull requests read/write. Pushes to protected branches are stopped
              by a GitHub ruleset, not by the token - fine-grained PATs have no
              branch dimension. Typically the decrypted path from sops-nix.

              Must be readable by the container's agent uid: the credential
              helper and `gh` both `cat` this file as agent, and this container
              runs with PRIVATE_USERS=no so that uid is a plain host uid, not a
              namespaced one. sops-nix's default (`mode = "0400"`, `owner =
              "root"`) is unreadable to it. sops-nix's `owner` takes a host
              *username*, and no host user has uid 1500 (the container agent's
              pinned uid, chosen deliberately outside the host's uid range - see
              container.nix), so `owner` cannot name this uid at all. Set
              `mode = "0440"` with `group = "users"` instead (gid 100, which
              exists on the host and is the container agent's primary group).
            '';
            example = "/run/secrets/devbox-github-token";
          };

          paseoPasswordFile = mkOption {
            type = types.path;
            description = ''
              Path on the host to a file containing the paseo daemon password as
              an environment variable assignment, e.g.
              `PASEO_PASSWORD=<secret>`. Tailnet membership is not treated as
              sufficient authentication on its own: an ACL mistake or a single
              compromised tailnet device would otherwise mean a shell over every
              repo.

              Unlike githubTokenFile, this does NOT need to be readable by the
              container's agent uid: it is consumed via the paseo systemd unit's
              `EnvironmentFile=`, which PID 1 reads as root while building the
              unit's execution environment, before the process ever drops to
              `User=agent`. sops-nix's default (`mode = "0400"`, `owner = "root"`)
              is therefore sufficient - and preferable, since it keeps the secret
              out of reach of anything running as agent, including a compromised
              coding agent process. Typically the decrypted path from sops-nix.
            '';
            example = "/run/secrets/devbox-paseo-password";
          };

          tailnetHostname = mkOption {
            type = types.str;
            description = ''
              Fully-qualified tailnet name the container is served on. Used for
              paseo's Host-header allowlist, and it must match what the manual
              `tailscale serve` publishes - a mismatch causes 400 errors.
            '';
            example = "devbox.mist-gamma.ts.net";
          };

          signingKeyFile = mkOption {
            type = types.nullOr types.path;
            default = null;
            description = ''
              Path on the host to an unencrypted ed25519 SSH private key used
              to sign git commits inside the container. Typically the decrypted
              path from sops-nix.

              Must be mode 0400 owned by uid 1500. git signs by running
              `ssh-keygen -Y sign` as the agent, and OpenSSH ignores a private
              key it does not own or that a group or other bit can reach;
              sops-nix expresses that uid through its numeric `uid` option.

              No passphrase - nothing in the container can prompt for one.

              null leaves this instance unable to sign, and commit.gpgSign off
              with it: git refuses to commit at all when signing is on and the
              key is absent, so the key and the flag are set as one unit.

              Each instance normally gets its own signing key rather than
              sharing one, so a commit's signature identifies which container
              produced it.
            '';
            example = "/run/secrets/devbox-signing-key";
          };

          hostAddress = mkOption {
            type = types.str;
            description = ''
              Host side of this container's veth pair. Stated, not derived:
              deriving from the attrset would renumber every later instance
              when one is added or renamed, because Nix orders keys
              alphabetically rather than by insertion. A collision with any
              container on the host - not just another devbox - is an eval
              error, see the assertion below.
            '';
            example = "192.168.100.26";
          };

          localAddress = mkOption {
            type = types.str;
            description = ''
              Container side of this container's veth pair. See hostAddress.
            '';
            example = "192.168.100.27";
          };

          gitIdentity = {
            name = mkOption {
              type = types.str;
              default = "BJSummerfield";
              description = "git user.name inside the container.";
            };

            email = mkOption {
              type = types.str;
              default = "brianjsummerfield@gmail.com";
              description = "git user.email inside the container.";
            };
          };
        };
      }
    );
  };

  config = mkMerge [
    {
      # Unconditional: this must catch a collision between, say,
      # jellyfin-server and stalwart-server even on a host with no devbox at
      # all, so it cannot live inside the `cfg != {}` gate below.
      assertions = [
        {
          # A duplicate address produces a container that starts cleanly and
          # then cannot route, which reads as a NAT problem rather than a
          # config one.
          assertion = lib.length (lib.unique allContainerAddresses) == lib.length allContainerAddresses;
          message = ''
            hostAddress and localAddress must be unique across every
            container on this host. Got: ${lib.concatStringsSep ", " allContainerAddresses}
          '';
        }
      ];
    }
    (mkIf (cfg != { }) {
      assertions =
        mapAttrsToList (name: box: {
          # Must be FQDN to match paseo Host-header allowlist.
          assertion = lib.hasInfix "." box.tailnetHostname;
          message = ''
            mine.system.devboxes.${name}.tailnetHostname
            ("${box.tailnetHostname}") must be a fully-qualified tailnet
            hostname (e.g. "devbox.mist-gamma.ts.net"), not a bare node name.
          '';
        }) cfg
        ++ mapAttrsToList (name: _: {
          # ve-<name> is a network interface name, and Linux caps those at 15
          # characters. An over-long name fails when the container starts, not
          # when it is evaluated.
          assertion = builtins.stringLength name <= 12;
          message = ''
            mine.system.devboxes.${name}: instance names may be at most 12
            characters, because the veth interface "ve-${name}" must fit
            Linux's 15-character interface name limit.
          '';
        }) cfg;

      networking.nat = {
        enable = true;
        internalInterfaces = mapAttrsToList (name: _: "ve-${name}") cfg;
        externalInterface = config.mine.system.externalInterface;
      };

      # Persist each container's tailscale node identity across rebuilds.
      systemd.tmpfiles.rules = mapAttrsToList (
        name: _: "d /var/lib/tailscale-${name} 0700 root root -"
      ) cfg;

      containers = mapAttrs (name: box: {
        autoStart = true;
        privateNetwork = true;
        inherit (box) hostAddress localAddress;

        allowedDevices = [
          {
            modifier = "rwm";
            node = "/dev/net/tun";
          }
        ];

        bindMounts = {
          # needed for tailscale network
          "/dev/net/tun" = {
            hostPath = "/dev/net/tun";
            isReadOnly = false;
          };
          # Persists the tailscale node identity across container restarts
          # and rebuilds. This is what makes the manual `tailscale up` in the
          # header comment a genuinely one-time cost rather than a
          # per-rebuild ritual: wipe this host directory and you re-auth,
          # otherwise you never touch it again.
          "/var/lib/tailscale" = {
            hostPath = "/var/lib/tailscale-${name}";
            isReadOnly = false;
          };
          # Destination paths carry no instance name: they live in this
          # container's own mount namespace, so every instance can use the
          # same two, and container.nix stays free of instance identity.
          #
          # Rotating any of the three secret files needs `systemctl restart
          # container@<name>`: the bind mount resolves to the underlying file
          # once, at container start, and does not track later changes to it.
          "/run/secrets/github-token" = {
            hostPath = box.githubTokenFile;
            isReadOnly = true;
          };
          "/run/secrets/paseo-password" = {
            hostPath = box.paseoPasswordFile;
            isReadOnly = true;
          };
        }
        // lib.optionalAttrs (box.signingKeyFile != null) {
          "/run/secrets/signing-key" = {
            hostPath = box.signingKeyFile;
            isReadOnly = true;
          };
        };

        config = import ./container.nix {
          inherit inputs;
          inherit (box) tailnetHostname gitIdentity;
          signCommits = box.signingKeyFile != null;
        };
      }) cfg;
    })
  ];
}
