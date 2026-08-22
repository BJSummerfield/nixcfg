# Generic SNI edge: a layer4 listener owns host 443 and routes by
# ClientHello SNI — "tls" routes hand off to Caddy's own HTTPS server
# (automatic ACME, reverse_proxy), "tcp" routes and the fallback are raw
# byte proxies. Every connection no route claims (unknown SNI, no SNI,
# non-TLS) degrades to the fallback, so a registry mistake breaks the
# routed site, never the fallback service. Port 80 is Caddy's own HTTP-01
# lane. Architecture B (Caddy as sole TLS authority) is a route flipping
# from "tcp" to "tls", not a rewrite.
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
  routeBlock = name: r: ''
    @${name} tls sni ${lib.concatStringsSep " " r.hostnames}
    route @${name} {
      proxy ${if r.mode == "tls" then "127.0.0.1:${toString httpsPort}" else r.target}
    }
  '';
  # The fallback renders last: layer4 tries routes in order and a route
  # with no matcher matches everything.
  layer4Server =
    lib.concatStrings (lib.mapAttrsToList routeBlock cfg.routes)
    + lib.optionalString (cfg.fallback != null) ''
      route {
        proxy ${cfg.fallback}
      }
    '';
  tlsRoutes = lib.filterAttrs (_: r: r.mode == "tls") cfg.routes;
in
{
  options.mine.system.caddy = {
    enable = lib.mkEnableOption "SNI-routing Caddy edge owning host ports 80 and 443";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      description = "ACME account contact for certificates Caddy obtains.";
    };

    fallback = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "192.168.100.41:443";
      description = ''
        host:port receiving every connection no route claims, as raw
        bytes. null closes unclaimed connections instead.
      '';
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
                plain HTTP to target. tcp: encrypted passthrough to target.
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
        message = "mine.system.caddy: a hostname is claimed by more than one route";
      }
    ];

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];

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
      # and renews their certificates automatically.
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
