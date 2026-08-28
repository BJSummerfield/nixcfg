# Generic TLS edge: stock Caddy owns host ports 80 and 443. Every
# registered route gets a vhost; Caddy obtains and renews its certificates
# automatically (ACME over 80) and reverse-proxies to the target. A target
# written as an https:// URL is dialed with TLS and its certificate is not
# verified (insecure) - targets are internal addresses whose certificates,
# if any, do not cover them. Every connection no vhost claims (unknown SNI,
# no SNI, non-TLS) fails the handshake instead of reaching a service, so a
# registry mistake breaks the connection, never a routed site.
{
  lib,
  config,
  ...
}:
let
  cfg = config.mine.system.caddy;
  vhostExtraConfig =
    r:
    if lib.strings.hasPrefix "https://" r.target then
      # TLS upstream: the internal certificate is not verified.
      ''
        reverse_proxy ${r.target} {
          transport http {
            tls_insecure_skip_verify
          }
        }
      ''
    else
      "reverse_proxy ${r.target}";
in
{
  options.mine.system.caddy = {
    enable = lib.mkEnableOption "Caddy TLS edge owning host ports 80 and 443";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      description = "ACME account contact for certificates Caddy obtains.";
    };

    routes = lib.mkOption {
      default = { };
      description = ''
        Routing registry. Service modules register here guarded on this
        module's enable, so registrations are inert on hosts without an
        edge.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            hostnames = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = "SNI names this route claims.";
            };
            target = lib.mkOption {
              type = lib.types.str;
              example = "192.168.100.51:8080";
              description = ''
                host:port behind this route (plain HTTP), or an https://
                URL dialed with TLS and an unverified upstream certificate.
              '';
            };
          };
        }
      );
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.allUnique (lib.concatMap (r: r.hostnames) (lib.attrValues cfg.routes));
        message = "mine.system.caddy: a hostname is claimed by more than one route";
      }
    ];

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];

    # The ACME account key and issued certificates. Restoring them beats
    # re-issuing into Let's Encrypt's duplicate-certificate limit after a
    # rebuild. No container to stop: caddy writes JSON files, not a database.
    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/caddy" ];
    };

    services.caddy = {
      enable = true;
      # Stock nixpkgs caddy - the in-tree reverse_proxy and ACME are all
      # this edge needs.
      email = cfg.acmeEmail;
      # One vhost per hostname of every route; Caddy obtains and renews
      # their certificates automatically.
      virtualHosts = lib.mkMerge (
        lib.mapAttrsToList (
          _: r:
          lib.genAttrs r.hostnames (_: {
            extraConfig = vhostExtraConfig r;
          })
        ) cfg.routes
      );
    };
  };
}
