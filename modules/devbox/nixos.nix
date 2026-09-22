# Once an instance is running, substituting its attribute name for <name>:
# sudo nixos-container root-login <name>
# tailscale up --hostname=<name> --advertise-tags=tag:devbox
# tailscale serve --bg 6767
# With hermesEnvFile set, also:
# tailscale serve --bg --https=9119 9119
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
    mkOption
    types
    ;
  cfg = config.mine.system.devboxes;
  addresses =
    mapAttrsToList (_: box: box.hostAddress) cfg ++ mapAttrsToList (_: box: box.localAddress) cfg;
in
{
  options.mine.system.devboxes = mkOption {
    default = { };
    description = ''
      Coding-agent containers, keyed by container name. Presence in this
      attrset is what enables a container - there is no separate enable
      flag, matching how `containers.*` itself reads.
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
            '';
            example = "/run/secrets/devbox-signing-key";
          };

          hermesEnvFile = mkOption {
            type = types.nullOr types.path;
            default = null;
            description = ''
              Path on the host to an environment file for Hermes Agent.
              Setting it is what adds Hermes to this instance: the gateway
              and the web dashboard, running as agent over the same checkouts
              as paseo, with the dashboard published on the tailnet at
              `https://<tailnetHostname>:9119`.

              Required lines:

                  HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=<dashboard password>
                  HERMES_DASHBOARD_BASIC_AUTH_SECRET=<openssl rand -hex 32>

              The secret signs login sessions so they survive a restart. It
              must be at least 16 bytes: a shorter one makes the password
              provider fail to construct, and the dashboard then refuses to
              start with "no auth providers are registered" rather than
              naming the secret.

              Optional provider keys go in the same file, e.g.
              `ANTHROPIC_API_KEY=<key>`. They cannot be entered at runtime
              instead: under the NixOS module Hermes refuses every write to
              its own config and .env, so `hermes model` and the dashboard's
              API Keys page do not persist anything.

              The password is mandatory because the dashboard is reached
              through `tailscale serve`, and Hermes only accepts a
              non-loopback Host header for a declared public URL, which in
              turn forces its auth gate on.

              sops-nix's default (`mode = "0400"`, `owner = "root"`) is
              sufficient: activation reads the file as root and merges it
              into `/var/lib/hermes/.hermes/.env`. That copy is readable by
              agent, which Hermes itself runs as.

              null leaves Hermes out of the container entirely.
            '';
            example = "/run/secrets/devbox-hermes-env";
          };

          hermesPlugins.enable = mkOption {
            type = types.bool;
            default = true;
            description = ''
              Whether this instance gets the shared Hermes plugins from
              modules/devbox/hermes-plugins/. Turning it off while
              hermesProfiles is on fails evaluation. No effect without
              hermesEnvFile.
            '';
          };

          hermesProfiles.enable = mkOption {
            type = types.bool;
            default = true;
            description = ''
              Whether this instance gets the shared Hermes agent profiles from
              modules/devbox/hermes-profiles-catalog.nix. false runs Hermes
              here with the default profile alone. No effect without
              hermesEnvFile.
            '';
          };

          hostAddress = mkOption {
            type = types.str;
            description = ''
              Host side of this container's veth pair. Required rather than
              derived: stating it puts every instance's addresses side by side
              in the host config, where a collision is visible.
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

  config = mkIf (cfg != { }) {
    assertions =
      mapAttrsToList (name: box: {
        assertion = lib.hasInfix "." box.tailnetHostname;
        message = ''
          mine.system.devboxes.${name}.tailnetHostname
          ("${box.tailnetHostname}") must be a fully-qualified tailnet
          hostname (e.g. "devbox.mist-gamma.ts.net"), not a bare node name.
        '';
      }) cfg
      ++ mapAttrsToList (name: _: {
        assertion = builtins.stringLength name <= 12;
        message = ''
          mine.system.devboxes.${name}: instance names may be at most 12
          characters, because the veth interface "ve-${name}" must fit
          Linux's 15-character interface name limit.
        '';
      }) cfg
      ++ [
        {
          assertion = lib.length (lib.unique addresses) == lib.length addresses;
          message = ''
            mine.system.devboxes: hostAddress and localAddress must be unique
            across every instance. Got: ${lib.concatStringsSep ", " addresses}
          '';
        }
      ];

    networking.nat = {
      enable = true;
      internalInterfaces = mapAttrsToList (name: _: "ve-${name}") cfg;
      externalInterface = config.mine.system.externalInterface;
    };

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
        "/dev/net/tun" = {
          hostPath = "/dev/net/tun";
          isReadOnly = false;
        };
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-${name}";
          isReadOnly = false;
        };
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
      }
      // lib.optionalAttrs (box.hermesEnvFile != null) {
        "/run/secrets/hermes-env" = {
          hostPath = box.hermesEnvFile;
          isReadOnly = true;
        };
      };

      config.imports = [
        (import ./container.nix {
          inherit inputs;
          inherit (box) tailnetHostname gitIdentity;
          signCommits = box.signingKeyFile != null;
        })
      ]
      ++ lib.optional (box.hermesEnvFile != null) (
        import ./hermes.nix {
          inherit inputs;
          inherit (box) tailnetHostname;
          agentProfiles = box.hermesProfiles.enable;
          agentPlugins = box.hermesPlugins.enable;
        }
      );
    }) cfg;
  };
}
