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

  vps = inputs.self.nixosConfigurations.vps.config;

  container = host.containers.photoform.config;
  unit = container.systemd.services.photoform;
  env = unit.environment;
  creds = unit.serviceConfig.LoadCredential;

  checks = [
    {
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
      name = "no secret value is carried in the environment itself";
      ok =
        !(env ? BOOKING_PAYPAL_CLIENT_SECRET)
        && !(env ? BOOKING_SMTP_PASSWORD)
        && !(env ? BOOKING_ADMIN_PASSWORD)
        && !(env ? BOOKING_SHEETS_SERVICE_ACCOUNT);
    }
    {
      name = "the config is named out of the package, not passed as a flag";
      ok =
        (env.BOOKING_CONFIG or null) == "${photoform}/${photoform.configPath}"
        && !(lib.hasInfix "--config" unit.serviceConfig.ExecStart);
    }
    {
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
      name = "the edge runs exactly the module's caddy-l4 build";
      ok = host.services.caddy.package == pkgs.callPackage ../modules/caddy/package.nix { };
    }
    {
      name = "a tls route is matched by SNI and handed to caddy's own HTTPS server";
      ok = lib.hasInfix "@photoform tls sni booking.summerfieldphotography.com\nroute @photoform {\n  proxy 127.0.0.1:8443" gc;
    }
    {
      name = "a tcp route is proxied raw to its target";
      ok = lib.hasInfix "@passthrough tls sni mx1.example.com\nroute @passthrough {\n  proxy 192.168.100.41:443" gc;
    }
    {
      name = "a tcp route gets no vhost, so caddy never issues for it";
      ok =
        host.services.caddy.virtualHosts ? "booking.summerfieldphotography.com"
        && !(host.services.caddy.virtualHosts ? "mx1.example.com");
    }
    {
      name = "no unmatched route block: unclaimed connections are closed, not forwarded";
      ok = !(lib.hasInfix "route {" gc);
    }
    {
      name = "the state directory is registered for backup with a container stop";
      ok =
        lib.elem "/var/lib/photoform-data" host.mine.backups.paths
        && lib.elem "photoform" host.mine.backups.stopContainers;
    }
    {
      name = "vps's real mail route is registered as tcp passthrough to stalwart";
      ok =
        vps.mine.system.caddy.routes ? mail
        && vps.mine.system.caddy.routes.mail.mode == "tcp"
        && vps.mine.system.caddy.routes.mail.hostnames == [ "mx1.brianjs.com" ]
        && vps.mine.system.caddy.routes.mail.target == "192.168.100.41:443";
    }
    {
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
