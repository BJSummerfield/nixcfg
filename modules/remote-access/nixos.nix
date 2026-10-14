{ lib, config, ... }:
let
  cfg = config.mine.system.remoteAccess;
  sshKeysRegistry = config.mine.users.${cfg.user}.sshKeys;
in
{
  options.mine.system.remoteAccess = {
    enable = lib.mkEnableOption ''
      the host remote-access posture: tailscale + tailscale-SSH + the sshd exposure
      posture + the default authorizedKeys set. Wires the existing tailscale and
      openssh modules; never activates tailscale (activation stays a one-time manual
      `tailscale up`, see the design manual-activation policy).
    '';

    lanAccess = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Open SSH on mine.system.externalInterface (on port `port`, default 22)
        because it is a trusted-LAN NIC.
        Set on: elitebook, paynefield, streamer.

        Supersedes the existing mine.system.openssh.inbound.openOnExternalInterface
        option for hosts that use this module.
      '';
    };

    publicAccess = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Open SSH on the external interface (on port `port`, default 22) even
        though it is a public NIC.
        vps-class only; OFF by default and NOT set by the wave-4 migration (Variant A:
        tailscale-only). Key-only auth is guaranteed by modules/openssh/nixos.nix
        (password auth off, PermitRootLogin no). Mutually exclusive with lanAccess.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 22;
      description = ''
        The TCP port sshd listens on (sets mine.system.openssh.inbound.port, i.e.
        services.openssh.ports — upstream reworked the option from a single
        `port` to a list). The tailnet path follows the same port because
        sshd listens on a single port — the tailscale0 firewall rule tracks
        services.openssh.ports.

        Supersedes the existing mine.system.openssh.inbound.port for hosts that use
        this module: setting both to different values produces a definition
        conflict — set it here (both must agree if both are set).
      '';
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "waktu";
      description = "The user whose authorizedKeys this module manages (must have a non-empty sshKeys registry — asserted).";
    };

    authorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = lib.attrNames sshKeysRegistry;
      description = ''
        Names of keys from mine.users.${cfg.user}.sshKeys that are authorized to log in
        as that user on this host.

        DEFAULT = the whole sshKeys registry (users/waktu.nix: onepassword, t495,
        redtruck, mac) — what four of the six hosts set today. t495 and redtruck each
        omit their own self key (3 keys); taking the default would add local self-SSH,
        so those two hosts set this explicitly to stay behavior-preserving. The existing
        authorizedKeys ⊆ sshKeys assertion (modules/users/nixos.nix) is unchanged and
        still applies to the value this option feeds.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Reuses the existing tailscale module as-is (modules/tailscale/nixos.nix): it
    # enables the tailscaled daemon, force-enables openssh.inbound and allows the
    # sshd port on tailscale0. NOT wired (manual-activation policy): no auth key, no up-flags — the
    # module owns daemon enable+ssh only; the one-time `tailscale up [flags]` is a
    # documented per-host step.
    mine.system.tailscale = {
      enable = true;
      ssh = true;
    };

    mine.system.openssh.inbound = {
      enable = true;
      inherit (cfg) port;
      openOnExternalInterface = cfg.lanAccess || cfg.publicAccess;
    };

    mine.users.${cfg.user}.authorizedKeys = cfg.authorizedKeys;

    assertions = [
      {
        assertion = lib.length (lib.attrNames sshKeysRegistry) > 0;
        message = "mine.system.remoteAccess.user '${cfg.user}' must have a non-empty mine.users.${cfg.user}.sshKeys registry (the default authorizedKeys set is drawn from it).";
      }
      {
        assertion = !(cfg.lanAccess && cfg.publicAccess);
        message = "mine.system.remoteAccess.lanAccess and publicAccess are mutually exclusive — a host is either LAN-open or public-open, not both on one NIC.";
      }
      # lanAccess/publicAccess ⇒ mine.system.externalInterface set is enforced by the
      # existing mine.system.openssh.inbound.openOnExternalInterface assert (we set it
      # to cfg.lanAccess || cfg.publicAccess above); no duplicate assert here.
    ];
  };
}
