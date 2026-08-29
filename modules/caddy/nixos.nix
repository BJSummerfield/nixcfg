# Generic SNI edge: stock Caddy owns host port 443 and is the sole TLS
# authority for every route it claims. Each route renders one vhost per
# claimed hostname, terminating with its own Let's Encrypt certificate
# (automatic ACME over the port 80 HTTP-01 lane) and reverse-proxying to
# the target. A route's `extraConfig` tunes the upstream transport — a
# TLS upstream needs a `transport http` block. Every connection no route
# claims (unknown SNI, no SNI) fails closed at the handshake: there is no
# default vhost and no on-demand issuance, so Caddy serves no certificate
# at all and aborts with a TLS internal_error alert (verified against
# caddy 2.11.4) — never a data path.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.system.caddy;
  # The nixpkgs module pipes the rendered Caddyfile through `caddy fmt`,
  # which owns indentation entirely — so this only has to get the block
  # structure right, never the whitespace.
  routeBody =
    r:
    if r.extraConfig == "" then
      "reverse_proxy ${r.target}"
    else
      lib.concatStrings [
        "reverse_proxy ${r.target} {\n"
        (lib.removeSuffix "\n" r.extraConfig)
        "\n}"
      ];
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
              type = lib.types.lines;
              default = "";
              example = ''
                transport http {
                  tls_server_name mx1.brianjs.com
                }
              '';
              description = ''
                Extra Caddyfile directives nested inside the route's
                reverse_proxy block, e.g. the upstream transport for a
                TLS target. Write them unescaped in an indented string;
                `caddy fmt` reindents the result, so the indentation
                here is free-form.
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
      {
        # genAttrs over an empty list yields no vhost, so such a route
        # would silently claim nothing rather than fail.
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
            extraConfig = routeBody r;
          })
        ) cfg.routes
      );
    };
  };
}
