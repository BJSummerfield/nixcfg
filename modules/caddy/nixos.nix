# Generic SNI edge: stock Caddy owns host port 443 and is the sole TLS
# authority for every route it claims. Each route renders one vhost per
# claimed hostname, terminating with its own Let's Encrypt certificate
# (automatic ACME over the port 80 HTTP-01 lane) and reverse-proxying to
# the target. A route's `extraConfig` tunes the upstream transport — a
# TLS upstream needs `transport http { tls tls_insecure_skip_verify }`. Every
# connection no route claims (unknown SNI, no SNI) fails closed: it gets
# the default vhost's cert and a TLS name mismatch, never a data path.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.caddy;
in
{
  options.mine.system.caddy = {
    enable = lib.mkEnableOption "SNI-routing Caddy edge owning host ports 80 and 443";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      description = "ACME account contact for certificates Caddy obtains.";
    };

    routes = lib.mkOption {
      default = { };
      description = ''
        SNI routing registry. Service modules register here guarded on
        this module's enable, so registrations are inert on hosts
        without an edge.
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
                host:port (plain-HTTP upstream) or a full URL
                (https://host:port TLS upstream) behind this route.
              '';
            };
            extraConfig = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "transport http {\n\t\ttls\n\t\ttls_insecure_skip_verify\n\t}";
              description = ''
                Extra Caddyfile lines nested inside the route's
                block-form reverse_proxy, e.g. the upstream
                transport for a TLS target.
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
      # Stock nixpkgs caddy. The VPS substitutes it from cache.nixos.org,
      # which nixpkgs appends (mkAfter) to every NixOS host's substituters
      # — including this host's private-cache list — so the 1 GB box never
      # compiles it.
      package = pkgs.caddy;
      email = cfg.acmeEmail;
      # One vhost per hostname of every route; Caddy obtains and renews
      # their certificates automatically.
      virtualHosts = lib.mkMerge (
        lib.mapAttrsToList (
          _: r:
          lib.genAttrs r.hostnames (_: {
            extraConfig =
              if r.extraConfig != null then
                "reverse_proxy ${r.target} {\n${r.extraConfig}\n}"
              else
                "reverse_proxy ${r.target}";
          })
        ) cfg.routes
      );
    };
  };
}
