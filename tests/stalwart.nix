# Pure-evaluation checks binding the stalwart container to the caddy edge's
# certificate export. Stalwart's own ACME cannot renew while caddy terminates
# :443, so the published certificate and the reload that follows it are the
# only thing standing between a renewal and expired mail TLS on 25/465/993.
{
  nixpkgs,
  inputs,
  system,
}:
let
  inherit (nixpkgs) lib;
  pkgs = nixpkgs.legacyPackages.${system};

  mkHost =
    extra:
    (lib.nixosSystem {
      specialArgs = { inherit inputs; };
      modules = [
        inputs.sops-nix.nixosModules.sops
        ../modules/system/nixos.nix
        ../modules/backups/nixos.nix
        ../modules/caddy/nixos.nix
        ../modules/stalwart-server/nixos.nix
        {
          nixpkgs.hostPlatform = system;
          fileSystems."/" = {
            device = "/dev/null";
            fsType = "ext4";
          };

          mine = {
            system = {
              hostName = "stalwart-test";
              externalInterface = "eth0";
              stalwart-server = {
                enable = true;
                adminPasswordFile = "/dev/null";
                apiKeyFile = "/dev/null";
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
        extra
      ];
    }).config;

  # The mail route lives in hosts/vps, not the module, so the test supplies it.
  host = mkHost {
    mine.system.caddy = {
      enable = true;
      acmeEmail = "test@example.com";
      routes.mail = {
        hostnames = [ "mx1.brianjs.com" ];
        target = "https://192.168.100.41:443";
      };
    };
  };

  # Same, but no route claims the exported hostname.
  unclaimed = mkHost {
    mine.system.caddy = {
      enable = true;
      acmeEmail = "test@example.com";
    };
  };

  export = host.mine.system.caddy.certExports.stalwart;
  publish = host.systemd.services."caddy-cert-export-stalwart";

  checks = [
    {
      name = "the stalwart module registers a cert export for the mail hostname";
      ok = export.hostname == "mx1.brianjs.com" && export.destination == "/var/lib/stalwart-certs";
    }
    {
      # root:stalwart-certs 0640 — the container's stalwart-mail uid is
      # allocated dynamically and is not knowable at eval time, so read access
      # comes from a static gid shared by host and container instead.
      name = "the export publishes as root:stalwart-certs";
      ok = export.owner == "root" && export.group == "stalwart-certs";
    }
    {
      name = "a path unit and a backstop timer both drive the publish service";
      ok =
        host.systemd.paths ? "caddy-cert-export-stalwart"
        && host.systemd.timers ? "caddy-cert-export-stalwart";
    }
    {
      name = "the publish service watches caddy's real certificate directory";
      ok = lib.hasInfix "acme-v02.api.letsencrypt.org-directory/mx1.brianjs.com" (
        builtins.head host.systemd.paths."caddy-cert-export-stalwart".pathConfig.PathChanged
      );
    }
    {
      # An unclaimed hostname would publish nothing, silently: caddy only
      # obtains certificates for names it serves.
      name = "an export whose hostname no route claims fails the assertion";
      ok = lib.any (a: !a.assertion && lib.hasInfix "claimed by no route" a.message) unclaimed.assertions;
    }
    {
      name = "the publish service is a oneshot ordered after caddy";
      ok = publish.serviceConfig.Type == "oneshot" && lib.elem "caddy.service" publish.after;
    }
  ];

  failures = builtins.filter (c: !c.ok) checks;
in
pkgs.runCommand "stalwart-eval-tests" { } (
  if failures == [ ] then
    "touch $out"
  else
    ''
      ${lib.concatMapStringsSep "\n" (f: "echo ${lib.escapeShellArg "FAIL: ${f.name}"} >&2") failures}
      exit 1
    ''
)
