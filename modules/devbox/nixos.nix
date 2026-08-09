# Persistent coding-agent container. Security boundary: ssh/sops/signing keys
# stay on the host. Repos live in the container filesystem — GitHub holds the code.
#
# Once the container is running, join the tailnet and publish paseo once:
# sudo nixos-container root-login devbox
# tailscale up --hostname=devbox --advertise-tags=tag:devbox
# tailscale serve --bg 6767
#
# Both are one-time. /var/lib/tailscale is bind-mounted to
# /var/lib/tailscale-devbox on the host, so the node identity and the serve
# config survive container restarts and rebuilds; you only redo this if
# that host directory is wiped. Manual tailscale join — more reliable than
# declarative on nspawn containers.
{ config, lib, pkgs, inputs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.mine.system.devbox;
in
{
  options.mine.system.devbox = {
    enable = mkEnableOption "persistent coding-agent devbox container";

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
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        # Must be FQDN to match paseo Host-header allowlist.
        assertion = lib.hasInfix "." cfg.tailnetHostname;
        message = ''
          mine.system.devbox.tailnetHostname ("${cfg.tailnetHostname}") must
          be a fully-qualified tailnet hostname (e.g.
          "devbox.mist-gamma.ts.net"), not a bare node name.
        '';
      }
    ];

    networking.nat = {
      enable = true;
      internalInterfaces = [ "ve-devbox" ];
      externalInterface = config.mine.system.externalInterface;
    };

    # Persist tailscale node identity across rebuilds.
    systemd.tmpfiles.rules = [
      "d /var/lib/tailscale-devbox 0700 root root -"
    ];

    containers.devbox = {
      # Flipped to true only after the sops secrets exist on disk; a
      # bindMount whose hostPath is missing fails at container start.
      autoStart = true;
      privateNetwork = true;
      hostAddress = "192.168.100.26";
      localAddress = "192.168.100.27";

      allowedDevices = [
        { modifier = "rwm"; node = "/dev/net/tun"; }
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
          hostPath = "/var/lib/tailscale-devbox";
          isReadOnly = false;
        };
        "/run/secrets/devbox-github-token" = {
          hostPath = cfg.githubTokenFile;
          isReadOnly = true;
        };
        "/run/secrets/devbox-paseo-password" = {
          hostPath = cfg.paseoPasswordFile;
          isReadOnly = true;
        };
      };

      config = import ./container.nix {
        inherit inputs;
        inherit (cfg) tailnetHostname;
      };
    };
  };
}