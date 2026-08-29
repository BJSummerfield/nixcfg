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
  # Caddy's on-disk layout. The ACME-directory segment is derived from the
  # CA URL; this module never sets a custom CA, so Let's Encrypt production
  # is the only value it can take.
  certDirFor =
    h:
    "${config.services.caddy.dataDir}/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${h}";

  claimedHostnames = lib.concatMap (r: r.hostnames) (lib.attrValues cfg.routes);

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

    certExports = lib.mkOption {
      default = { };
      description = ''
        Certificates to copy out of caddy's storage for another service to
        read. Registered by service modules guarded on this module's enable,
        so registrations are inert on hosts without an edge.

        Caddy owns the storage layout: the path embeds both caddy's internal
        directory structure and the ACME directory URL, so a consumer that
        mounted it directly would break on a CA change.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            hostname = lib.mkOption {
              type = lib.types.str;
              example = "mx1.brianjs.com";
              description = "A hostname claimed by one of the routes above.";
            };
            destination = lib.mkOption {
              type = lib.types.path;
              example = "/var/lib/stalwart-certs";
              description = ''
                Directory to publish `cert.pem` and `key.pem` into.
              '';
            };
            owner = lib.mkOption {
              type = lib.types.str;
              default = "root";
              description = "Owner of the published files.";
            };
            group = lib.mkOption {
              type = lib.types.str;
              description = ''
                Group of the published files, which are mode 0640. Consumers
                running as another user read them via group membership.
              '';
            };
            postPublish = lib.mkOption {
              type = lib.types.lines;
              default = "";
              description = ''
                Shell run after a successful copy — typically telling the
                consumer to re-read the certificate. Runs as root on the host.
                A non-zero exit fails the publish unit.
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
      {
        assertion = lib.all (e: lib.elem e.hostname claimedHostnames) (lib.attrValues cfg.certExports);
        message = "mine.system.caddy: a cert export names a hostname claimed by no route, so caddy would never obtain it";
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

    # One publish unit per export. The path unit catches a renewal within
    # seconds; the timer is the backstop, on the same reasoning as
    # systemd.timers.devbox-warm — a missed inotify event here is cheap to
    # guard against and expensive to suffer, because the failure is an
    # expired certificate on mail ports that bypass caddy entirely.
    systemd.services = lib.mapAttrs' (
      name: e:
      lib.nameValuePair "caddy-cert-export-${name}" {
        description = "Publish caddy's ${e.hostname} certificate to ${e.destination}";
        after = [ "caddy.service" ];
        wants = [ "caddy.service" ];
        serviceConfig.Type = "oneshot";
        path = [
          pkgs.coreutils
          pkgs.openssl
        ];
        script = ''
          set -euo pipefail
          install -d -m 0750 -o ${e.owner} -g ${e.group} ${e.destination}
          install -m 0640 -o ${e.owner} -g ${e.group} \
            ${certDirFor e.hostname}/${e.hostname}.crt ${e.destination}/cert.pem
          install -m 0640 -o ${e.owner} -g ${e.group} \
            ${certDirFor e.hostname}/${e.hostname}.key ${e.destination}/key.pem
          ${e.postPublish}
        '';
      }
    ) cfg.certExports;

    systemd.paths = lib.mapAttrs' (
      name: e:
      lib.nameValuePair "caddy-cert-export-${name}" {
        description = "Watch caddy's ${e.hostname} certificate for renewal";
        wantedBy = [ "multi-user.target" ];
        pathConfig.PathChanged = [ (certDirFor e.hostname) ];
      }
    ) cfg.certExports;

    systemd.timers = lib.mapAttrs' (
      name: e:
      lib.nameValuePair "caddy-cert-export-${name}" {
        description = "Backstop republish of caddy's ${e.hostname} certificate";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = "daily";
          Persistent = true;
        };
      }
    ) cfg.certExports;

    users.groups = lib.mapAttrs' (_: e: lib.nameValuePair e.group { }) cfg.certExports;
  };
}
