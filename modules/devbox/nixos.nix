# Once the container is running, join the tailnet and publish paseo once:
# sudo nixos-container root-login devbox
# tailscale up --hostname=devbox --advertise-tags=tag:devbox
# tailscale serve --bg 6767
#
# Both are one-time. /var/lib/tailscale is bind-mounted to
# /var/lib/tailscale-devbox on the host, so the node identity and the serve
# config survive container restarts and rebuilds; you only redo this if
# that host directory is wiped. Declarative join (authKeyFile /
# extraUpFlags / a serve oneshot) was tried and removed - it is persistently
# flaky on nixos-containers, and the same manual ritual used by
# vikunja-server and local-llm is what actually works.
#
# --hostname must match the first label of mine.system.devbox.tailnetHostname,
# which is what paseo checks in the Host header. They disagree -> connects,
# then 400s.
#
# Persistent coding-agent container. Replaces the ephemeral coding-agents
# pool, whose container lifetime was tied to the launching SSH session -
# fine at a desk, fatal for a phone client whose connection drops.
#
# The security boundary is unchanged: ssh keys, sops keys and the commit
# signing key stay on the host and are never bind-mounted in. What changed
# is that the container is now long-lived and owns the repos, so a dropped
# client is just a closed window.
#
# Repos live in the container's own filesystem at
# /var/lib/nixos-containers/devbox/home/agent/projects - not backed up,
# by design: GitHub holds the code.
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
        `tailscale serve` publishes - a mismatch presents as a connection
        that establishes and then 400s.
      '';
      example = "devbox.mist-gamma.ts.net";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        # paseo's Host-header check keys off this exact string, and the
        # manual `tailscale up --hostname=` in the header comment must
        # agree with its first label. A bare node name here is silently
        # wrong rather than an error, and surfaces only as "connects, then
        # 400s" - which is a miserable thing to debug from a phone.
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

    # Tailscale node identity is the only container state kept on the host,
    # so a container rebuild rejoins as the same node instead of orphaning
    # one. Everything else lives in the container's own filesystem.
    systemd.tmpfiles.rules = [
      "d /var/lib/tailscale-devbox 0700 root root -"
    ];

    containers.devbox = {
      # Flipped to true only after the sops secrets exist on disk; a
      # bindMount whose hostPath is missing fails at container start.
      autoStart = false;
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
