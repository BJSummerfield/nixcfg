# Pure-evaluation checks binding the photoform module to the app's shipped
# contract. Every value here is a name the app reads at startup, so a
# mismatch is a service that will not start — and the whole set is visible
# at eval time, which makes a VM test unnecessary.
{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};
  photoform = pkgs.callPackage ../modules/photoform/package.nix { };

  host =
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        inputs.sops-nix.nixosModules.sops
        ../modules/system/nixos.nix
        ../modules/backups/nixos.nix
        ../modules/caddy/nixos.nix
        ../modules/photoform/nixos.nix
        {
          nixpkgs.hostPlatform = system;
          fileSystems."/" = {
            device = "/dev/null";
            fsType = "ext4";
          };

          mine = {
            system = {
              hostName = "photoform-test";
              externalInterface = "eth0";
              caddy = {
                enable = true;
                acmeEmail = "test@example.com";
                # A synthetic passthrough, standing in for the mail route.
                # The mail route itself is registered by the stalwart
                # module, which this test host does not import — but the
                # behaviour under test belongs to the caddy module.
                routes.passthrough = {
                  hostnames = [ "mx1.example.com" ];
                  mode = "tcp";
                  target = "192.168.100.41:443";
                };
              };
              photoform = {
                enable = true;
                sopsFile = ../secrets/hosts/vps.yaml;
              };
            };
            backups = {
              enable = true;
              repository = "s3:example/test";
              repoPasswordFile = "/dev/null";
              b2EnvFile = "/dev/null";
            };
          };
        }
      ];
    }).config;

  gc = host.services.caddy.globalConfig;

  # Binds the real vps configuration, not a synthetic stand-in. The
  # passthrough behaviour above is exercised only via the test host's
  # synthetic `routes.passthrough`; nothing else asserts that the actual
  # mail route on vps is `tcp` mode, so a regression there (or an
  # outright deletion of the route) would leave every other check in this
  # file green. Guard against that by reading vps's own config, since it
  # is a fixed point already realized elsewhere in checks/ (evalAll,
  # caddyfile-<host>) and does not depend on this check's output.
  vps = inputs.self.nixosConfigurations.vps.config;

  container = host.containers.photoform.config;
  unit = container.systemd.services.photoform;
  env = unit.environment;
  creds = unit.serviceConfig.LoadCredential;

  checks = [
    {
      # The app reads BOOKING_*, and reads the config path from
      # BOOKING_CONFIG. There is no --config flag. `or null` turns a renamed
      # variable into a reported FAIL rather than an eval crash.
      name = "every secret is named by its _FILE variable, pointing at a credential";
      ok =
        (env.BOOKING_PAYPAL_CLIENT_SECRET_FILE or null)
        == "/run/credentials/photoform.service/paypal-client-secret"
        && (env.BOOKING_SMTP_PASSWORD_FILE or null) == "/run/credentials/photoform.service/smtp-password"
        && (env.BOOKING_ADMIN_PASSWORD_FILE or null) == "/run/credentials/photoform.service/admin-password"
        &&
          (env.BOOKING_SHEETS_SERVICE_ACCOUNT_FILE or null) == "/run/credentials/photoform.service/sheets-sa";
    }
    {
      # A plain BOOKING_X would put the value in /proc/<pid>/environ; the
      # app supports that form for local development only.
      name = "no secret value is carried in the environment itself";
      ok =
        !(env ? BOOKING_PAYPAL_CLIENT_SECRET)
        && !(env ? BOOKING_SMTP_PASSWORD)
        && !(env ? BOOKING_ADMIN_PASSWORD)
        && !(env ? BOOKING_SHEETS_SERVICE_ACCOUNT);
    }
    {
      # Compares against the package's own configPath rather than a literal,
      # so a postInstall path change fails this instead of only production.
      name = "the config is named out of the package, not passed as a flag";
      ok =
        (env.BOOKING_CONFIG or null) == "${photoform}/${photoform.configPath}"
        && !(lib.hasInfix "--config" unit.serviceConfig.ExecStart);
    }
    {
      # BOOKING_CONFIG is only as trustworthy as configPath is honest about
      # where postInstall actually writes the file; this reads postInstall's
      # own source rather than the built output, so it needs no realization.
      name = "postInstall installs to the path configPath advertises";
      ok = lib.hasInfix photoform.configPath photoform.postInstall;
    }
    {
      name = "the container's bind mounts pair the state dir and each secret with its host path";
      ok =
        let
          bindMounts = host.containers.photoform.bindMounts;
        in
        bindMounts."/var/lib/photoform".hostPath == "/var/lib/photoform-data"
        &&
          bindMounts."/run/host-secrets/photoform-paypal-client-secret".hostPath
          == host.sops.secrets.photoform-paypal-client-secret.path
        &&
          bindMounts."/run/host-secrets/photoform-smtp-password".hostPath
          == host.sops.secrets.photoform-smtp-password.path
        &&
          bindMounts."/run/host-secrets/photoform-admin-password".hostPath
          == host.sops.secrets.photoform-admin-password.path
        &&
          bindMounts."/run/host-secrets/photoform-sheets-sa".hostPath
          == host.sops.secrets.photoform-sheets-sa.path;
    }
    {
      # LoadCredential is what makes a 0400 root-owned sops file readable by
      # the unprivileged in-container user; a bind mount alone would not.
      name = "all four secrets are loaded as credentials from their bind mounts";
      ok =
        lib.sort lib.lessThan creds == [
          "admin-password:/run/host-secrets/photoform-admin-password"
          "paypal-client-secret:/run/host-secrets/photoform-paypal-client-secret"
          "sheets-sa:/run/host-secrets/photoform-sheets-sa"
          "smtp-password:/run/host-secrets/photoform-smtp-password"
        ];
    }
    {
      name = "the host declares those four sops secrets and no others";
      ok =
        lib.sort lib.lessThan (lib.filter (lib.hasPrefix "photoform-") (lib.attrNames host.sops.secrets))
        == [
          "photoform-admin-password"
          "photoform-paypal-client-secret"
          "photoform-sheets-sa"
          "photoform-smtp-password"
        ];
    }
    {
      # The PayPal client ID is public and lives in the config file.
      name = "the PayPal client ID is not treated as a secret";
      ok = !(host.sops.secrets ? photoform-paypal-client-id) && !(host.sops.templates ? "photoform.env");
    }
    {
      name = "the edge routes the booking hostname to the container";
      ok =
        host.mine.system.caddy.routes.photoform.hostnames == [
          "booking.summerfieldphotography.com"
        ]
        && host.mine.system.caddy.routes.photoform.mode == "tls"
        && host.mine.system.caddy.routes.photoform.target == "192.168.100.51:8080";
    }
    {
      # The layer4 app is an out-of-tree plugin, so the edge must run
      # exactly the module's own caddy-l4 build, not stock nixpkgs caddy.
      # pkg-caddy-l4 is the CI gate on the vendor hash; this is the gate
      # on the module actually using that build.
      name = "the edge runs exactly the module's caddy-l4 build";
      ok = host.services.caddy.package == pkgs.callPackage ../modules/caddy/package.nix { };
    }
    {
      # The matcher and its target are asserted as one contiguous block,
      # not two independent infixes — otherwise this would still pass if
      # the tls/tcp proxy targets were swapped, since the tcp route's
      # target could satisfy the bare "proxy 127.0.0.1:8443" infix.
      name = "a tls route is matched by SNI and handed to caddy's own HTTPS server";
      ok = lib.hasInfix "@photoform tls sni booking.summerfieldphotography.com\nroute @photoform {\n  proxy 127.0.0.1:8443" gc;
    }
    {
      # The defining property of the mail path: layer4 hands the raw
      # connection to the backend, so the backend can answer TLS-ALPN-01
      # itself. Terminating here is what broke Stalwart's renewal.
      name = "a tcp route is proxied raw to its target";
      ok = lib.hasInfix "@passthrough tls sni mx1.example.com\nroute @passthrough {\n  proxy 192.168.100.41:443" gc;
    }
    {
      # If caddy rendered a vhost for a passthrough hostname it would try
      # to obtain that certificate itself, racing the backend for the same
      # name and consuming its duplicate-certificate budget.
      name = "a tcp route gets no vhost, so caddy never issues for it";
      ok =
        host.services.caddy.virtualHosts ? "booking.summerfieldphotography.com"
        && !(host.services.caddy.virtualHosts ? "mx1.example.com");
    }
    {
      # The fallback sent every unclaimed connection into Stalwart from the
      # veth gateway, which got that address auto-banned and 502'd webmail.
      # A bare `route {` with no matcher is what its return would look like.
      # To probe this by hand, `openssl s_client -connect` alone sets SNI
      # from the -connect host, so an unclaimed hostname still matches
      # @mail and appears to pass — add -noservername to actually test
      # rejection.
      name = "no unmatched route block: unclaimed connections are closed, not forwarded";
      ok = !(lib.hasInfix "route {" gc);
    }
    {
      # restic reads the host side of the bind mount, with the container
      # stopped so the WAL-mode database is consistent.
      name = "the state directory is registered for backup with a container stop";
      ok =
        lib.elem "/var/lib/photoform-data" host.mine.backups.paths
        && lib.elem "photoform" host.mine.backups.stopContainers;
    }
    {
      # Flipping vps's real mail route to "tls", or deleting it outright,
      # would silently reinstate the exact mail-TLS-renewal outage this
      # branch exists to undo, while every check above (which only
      # exercises the synthetic `routes.passthrough`) stays green. This
      # binds the assertion to the real host.
      name = "vps's real mail route is registered as tcp passthrough to stalwart";
      ok =
        vps.mine.system.caddy.routes ? mail
        && vps.mine.system.caddy.routes.mail.mode == "tcp"
        && vps.mine.system.caddy.routes.mail.hostnames == [ "mx1.brianjs.com" ]
        && vps.mine.system.caddy.routes.mail.target == "192.168.100.41:443";
    }
    {
      # A "tls" mail route (or a route rename that stops rendering it)
      # would make caddy issue and terminate mx1's certificate itself,
      # exactly the arrangement that broke Stalwart's TLS-ALPN-01 renewal.
      name = "vps's caddy never gets a vhost for the mail hostname, but does for booking";
      ok =
        vps.services.caddy.virtualHosts ? "booking.summerfieldphotography.com"
        && !(vps.services.caddy.virtualHosts ? "mx1.brianjs.com");
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "photoform-eval-tests" { } (
  if failures == [ ] then
    "touch $out"
  else
    ''
      ${lib.concatMapStringsSep "\n" (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
      exit 1
    ''
)
