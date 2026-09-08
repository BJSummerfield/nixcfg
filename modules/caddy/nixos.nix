{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.caddy;
  httpsPort = 8443;
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
        assertion = lib.all (r: r.hostnames != [ ]) (lib.attrValues cfg.routes);
        message = "mine.system.caddy: a route claims no hostnames and would render nothing";
      }
    ];

    networking.firewall.allowedTCPPorts = [
      80
      443
    ];

    mine.backups = lib.mkIf config.mine.backups.enable {
      paths = [ "/var/lib/caddy" ];
    };

    services.caddy = {
      enable = true;
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
