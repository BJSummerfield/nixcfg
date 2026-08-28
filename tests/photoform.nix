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
      name = "the edge terminates TLS for the booking hostname and reverse-proxies to the container";
      ok =
        host.mine.system.caddy.routes.photoform.hostnames == [
          "booking.summerfieldphotography.com"
        ]
        && host.mine.system.caddy.routes.photoform.target == "192.168.100.51:8080";
    }
    {
      # restic reads the host side of the bind mount, with the container
      # stopped so the WAL-mode database is consistent.
      name = "the state directory is registered for backup with a container stop";
      ok =
        lib.elem "/var/lib/photoform-data" host.mine.backups.paths
        && lib.elem "photoform" host.mine.backups.stopContainers;
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
