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

    tailscaleAuthKeyFile = mkOption {
      type = types.path;
      description = ''
        Path on the host to a Tailscale auth key, pre-authorized for the
        tag in tailscaleTags, so the container joins the tailnet on first
        boot without a manual `tailscale up`. Typically the decrypted path
        from sops-nix.
      '';
      example = "/run/secrets/devbox-tailscale-authkey";
    };

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
        "root"`) is unreadable to it - set `mode = "0440"` with a matching
        group, or `owner` to the agent uid, instead.
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
        repo. Must be readable by the container's agent uid. Typically the
        decrypted path from sops-nix.
      '';
      example = "/run/secrets/devbox-paseo-password";
    };

    tailnetHostname = mkOption {
      type = types.str;
      description = ''
        Fully-qualified tailnet name the container serves on. Used both by
        `tailscale serve` and by paseo's Host-header allowlist; a mismatch
        presents as a connection that establishes and then 400s.
      '';
      example = "devbox.mist-gamma.ts.net";
    };

    tailscaleTags = mkOption {
      type = types.listOf types.str;
      default = [ "tag:devbox" ];
      description = ''
        ACL tags advertised at join. The tag must already exist in the
        tailnet ACL policy and the auth key must be issued for it, or the
        join fails.
      '';
    };
  };

  config = mkIf cfg.enable {
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
        # persists the tailscale node identity across container restarts
        "/var/lib/tailscale" = {
          hostPath = "/var/lib/tailscale-devbox";
          isReadOnly = false;
        };
        "/run/secrets/devbox-tailscale-authkey" = {
          hostPath = cfg.tailscaleAuthKeyFile;
          isReadOnly = true;
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
        inherit (cfg) tailnetHostname tailscaleTags;
      };
    };
  };
}
