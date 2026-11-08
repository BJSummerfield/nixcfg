{
  lib,
  cfg,
  webui,
}:
let
  hasDns = cfg.namecheap != null;
  acmeDirectory =
    if cfg.acme.staging then
      "https://acme-staging-v02.api.letsencrypt.org/directory"
    else
      "https://acme-v02.api.letsencrypt.org/directory";
  domainKey = name: "domain-${lib.replaceStrings [ "." ] [ "-" ] name}";
  domainRef =
    name: if name == null || name == cfg.domain then "#main-domain" else "#${domainKey name}";
  dnsManagement =
    name:
    if hasDns then
      {
        "@type" = "Automatic";
        dnsServerId = "#dns-namecheap";
        origin = name;
        publishRecords = lib.listToAttrs (
          map (r: {
            name = r;
            value = true;
          }) cfg.publishRecords
        );
      }
    else
      {
        "@type" = "Manual";
      };
  dkimManagement =
    if hasDns && lib.elem "dkim" cfg.publishRecords then
      {
        "@type" = "Automatic";
      }
    else
      {
        "@type" = "Manual";
      };
in
[
  {
    "@type" = "reconcile";
    object = "NetworkListener";
    matchOn = [ "name" ];
    value = {
      l-smtp = {
        name = "smtp";
        protocol = "smtp";
        bind = {
          "[::]:25" = true;
        };
        implicitTls = false;
      };
      l-submissions = {
        name = "submissions";
        protocol = "smtp";
        bind = {
          "[::]:465" = true;
        };
        implicitTls = true;
      };
      l-imaps = {
        name = "imaps";
        protocol = "imap";
        bind = {
          "[::]:993" = true;
        };
        implicitTls = true;
      };
      l-http = {
        name = "http";
        protocol = "http";
        bind = {
          "127.0.0.1:8080" = true;
        };
        implicitTls = false;
        useTls = false;
      };
    };
  }
  {
    "@type" = "upsert";
    object = "Application";
    matchOn = [ "description" ];
    value = {
      app-webui = {
        description = "Stalwart Web Interface";
        enable = true;
        resourceUrl = "file://${webui}/webui.zip";
        urlPrefix = {
          "/admin" = true;
          "/account" = true;
        };
      };
    };
  }
  {
    "@type" = "reconcile";
    object = "Tracer";
    matchOn = [ "@type" ];
    value = {
      tracer-journal = {
        "@type" = "Journal";
        enable = true;
        level = "info";
      };
    };
  }
]
++ lib.optionals hasDns [
  {
    "@type" = "upsert";
    object = "DnsServer";
    matchOn = [ "description" ];
    value = {
      dns-namecheap = {
        "@type" = "Namecheap";
        description = "Namecheap";
        apiUser = cfg.namecheap.apiUser;
        clientIp = cfg.namecheap.clientIp;
        apiKey = {
          "@type" = "File";
          filePath = "/run/credentials/stalwart.service/namecheap-key";
        };
      }
      // lib.optionalAttrs (cfg.namecheap.username != null) {
        username = cfg.namecheap.username;
      };
    };
  }
  {
    "@type" = "upsert";
    object = "AcmeProvider";
    matchOn = [ "directory" ];
    value = {
      acme-le = {
        directory = acmeDirectory;
        contact = {
          "mailto:${cfg.acme.contact}" = true;
        };
        challengeType = "Dns01";
        description = "Let's Encrypt";
      };
    };
  }
]
++ [
  {
    "@type" = "upsert";
    object = "Domain";
    matchOn = [ "name" ];
    value = {
      main-domain = {
        name = cfg.domain;
        certificateManagement =
          if hasDns then
            {
              "@type" = "Automatic";
              acmeProviderId = "#acme-le";
              subjectAlternativeNames = {
                ${cfg.hostname} = true;
              };
            }
          else
            {
              "@type" = "Manual";
            };
        dnsManagement = dnsManagement cfg.domain;
        inherit dkimManagement;
      };
    }
    // lib.listToAttrs (
      map (
        name:
        lib.nameValuePair (domainKey name) {
          inherit name dkimManagement;
          dnsManagement = dnsManagement name;
          certificateManagement = {
            "@type" = "Manual";
          };
        }
      ) cfg.extraDomains
    );
  }
]
++ lib.optionals (cfg.accounts != { }) [
  {
    "@type" = "upsert";
    object = "Account";
    matchOn = [ "name" ];
    value = lib.mapAttrs' (
      name: account:
      lib.nameValuePair "account-${name}" (
        {
          "@type" = "User";
          inherit name;
          domainId = domainRef account.domain;
        }
        // lib.optionalAttrs (account.description != null) {
          inherit (account) description;
        }
      )
    ) cfg.accounts;
  }
]
++ [
  {
    "@type" = "update";
    object = "SystemSettings";
    value = {
      defaultHostname = cfg.hostname;
      defaultDomainId = "#main-domain";
    };
  }
  {
    "@type" = "create";
    object = "Action";
    value = {
      reload = {
        "@type" = "ReloadSettings";
      };
    };
  }
]
