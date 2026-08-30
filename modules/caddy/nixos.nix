# Generic SNI edge: a layer4 listener owns host 443 and routes by
# ClientHello SNI — "tls" routes hand off to Caddy's own HTTPS server
# (automatic ACME, reverse_proxy), "tcp" routes are raw byte proxies that
# let the backend terminate its own TLS. Every connection no route claims
# (unknown SNI, no SNI, non-TLS) is closed at the edge: there is no
# fallback, so internet scan traffic never reaches a backend. An earlier
# revision proxied unclaimed connections to Stalwart, which auto-banned
# the veth gateway and took webmail down with it.
#
# Port 80 is Caddy's own HTTP-01 lane. A "tcp" route's backend needs a
# challenge path of its own — for Stalwart that is TLS-ALPN-01, which
# works precisely because layer4 matches SNI before forwarding any bytes.
#
# A "tls" route loses the client's real address: layer4 dials
# 127.0.0.1:8443 with no proxy_protocol, so caddy's access log records
# 127.0.0.1 as the remote IP for every request, and a client-supplied
# X-Forwarded-For survives with 127.0.0.1 merely appended. This is a
# regression from a terminating stock-caddy edge for the booking site
# specifically — the mail side of this class of issue is handled by
# turning Stalwart's own use-x-forwarded off.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.caddy;
  # Where the HTTP app terminates TLS for layer4-matched hostnames. Only
  # the layer4 proxy dials it; the firewall never opens it.
  httpsPort = 8443;
  # The nixpkgs module pipes the rendered Caddyfile through `caddy fmt`,
  # which owns indentation entirely — so this only has to get the block
  # structure right, never the whitespace. That said, tests/photoform.nix
  # pins this function's exact rendered indentation via lib.hasInfix, so a
  # reindent here will break those assertions even though behavior did
  # not change.
  routeBlock = name: r: ''
    @${name} tls sni ${lib.concatStringsSep " " r.hostnames}
    route @${name} {
      proxy ${if r.mode == "tls" then "127.0.0.1:${toString httpsPort}" else r.target}
    }
  '';
  layer4Server = lib.concatStrings (lib.mapAttrsToList routeBlock cfg.routes);
  tlsRoutes = lib.filterAttrs (_: r: r.mode == "tls") cfg.routes;
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
            mode = lib.mkOption {
              type = lib.types.enum [
                "tls"
                "tcp"
              ];
              description = ''
                tls: Caddy terminates (automatic ACME) and reverse-proxies
                plain HTTP to target. tcp: encrypted passthrough, leaving
                target to terminate and renew its own certificate.
              '';
            };
            target = lib.mkOption {
              type = lib.types.str;
              example = "192.168.100.51:8080";
              description = "host:port behind this route.";
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
        message = "mine.system.caddy: a hostname is claimed twice";
      }
      {
        # A layer4 sni matcher with no names matches nothing and genAttrs
        # over an empty list yields no vhost, so such a route would
        # silently claim nothing rather than fail.
        assertion = lib.all (r: r.hostnames != [ ]) (lib.attrValues cfg.routes);
        message = "mine.system.caddy: a route claims no hostnames and would render nothing";
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
      # The l4 plugin pin lives in ./package.nix, cached by CI.
      package = pkgs.callPackage ./package.nix { };
      email = cfg.acmeEmail;
      globalConfig = ''
        http_port 80
        https_port ${toString httpsPort}
        layer4 {
          :443 {
            ${layer4Server}
          }
        }
      '';
      # One vhost per hostname of every terminating route; Caddy obtains
      # and renews their certificates automatically. "tcp" routes are
      # absent by design — their backend owns the certificate, and a vhost
      # here would make caddy race it for the same name.
      virtualHosts = lib.mkMerge (
        lib.mapAttrsToList (
          _: r:
          lib.genAttrs r.hostnames (_: {
            extraConfig = "reverse_proxy ${r.target}";
          })
        ) tlsRoutes
      );
    };
  };
}
