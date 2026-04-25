{ lib, config, ... }:
{
  options.mine.user.firefox.enable = lib.mkEnableOption "Enable firefox config";
  config = lib.mkIf config.mine.user.firefox.enable {
    programs.firefox = {
      enable = true;
      policies = {
        DisableTelemetry = true;
        DisableFirefoxStudies = true;
        DisableFirefoxAccounts = true;
        DisablePocket = true;
        SearchSuggestEnabled = false;

        EnableTrackingProtection = {
          Value = true;
          Locked = true;
          Cryptomining = true;
          Fingerprinting = true;
        };

        ExtensionSettings = {
          "*".installation_mode = "blocked";
          "uBlock0@raymondhill.net" = {
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
            installation_mode = "force_installed";
            private_browsing = true;
          };
          "{d7742d87-e61d-4b78-b8a1-b469842139fa}" = {
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/vimium-ff/latest.xpi";
            installation_mode = "force_installed";
            private_browsing = true;
          };
          # ClearURLs
          "{74145f27-f039-47ce-a470-a662b129930a}" = {
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/clearurls/latest.xpi";
            installation_mode = "force_installed";
            private_browsing = true;
          };
        };

        Preferences = {
          # DNS over HTTPS - never
          "network.trr.mode" = { Value = 5; Status = "locked"; };
          "network.trr.uri" = { Value = ""; Status = "locked"; };

          # Pocket and related
          "extensions.pocket.enabled" = { Value = false; Status = "locked"; };

          # New tab page - strip everything
          "browser.newtabpage.activity-stream.showWeather" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.feeds.topsites" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.feeds.system.topstories" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.showSponsoredTopSites" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.showSponsored" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.feeds.section.highlights" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.feeds.telemetry" = { Value = false; Status = "locked"; };
          "browser.newtabpage.activity-stream.telemetry" = { Value = false; Status = "locked"; };

          # Telemetry channels beyond the main policy
          "browser.crashReports.unsubmittedCheck.autoSubmit2" = { Value = false; Status = "locked"; };
          "app.shield.optoutstudies.enabled" = { Value = false; Status = "locked"; };
          "datareporting.healthreport.uploadEnabled" = { Value = false; Status = "locked"; };
          "datareporting.policy.dataSubmissionEnabled" = { Value = false; Status = "locked"; };

          # Tracking protection - strict
          "privacy.trackingprotection.enabled" = { Value = true; Status = "locked"; };
          "privacy.trackingprotection.pbmode.enabled" = { Value = true; Status = "locked"; };
          "privacy.trackingprotection.socialtracking.enabled" = { Value = true; Status = "locked"; };
          "network.cookie.cookieBehavior" = { Value = 5; Status = "locked"; };

          # WebRTC IP leak prevention
          "media.peerconnection.ice.default_address_only" = { Value = true; Status = "locked"; };
          "media.peerconnection.ice.no_host" = { Value = true; Status = "locked"; };

          # HTTPS-only mode
          "dom.security.https_only_mode" = { Value = true; Status = "locked"; };
        };
      };
    };
    stylix.targets.firefox.profileNames = [ "default" ];
  };
}
