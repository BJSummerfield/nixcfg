{
  lib,
  config,
  themeConstants,
  ...
}:
let
  inherit (lib) mkIf mkEnableOption;
  inherit (themeConstants) colors;
  # Firefox font prefs are px; theme sizes are pt (px = pt * 4/3)
  ptToPx = pt: builtins.floor (pt * 4.0 / 3.0);
in
{
  options.mine.user.firefox.enable = mkEnableOption "Enable firefox config";
  config = mkIf config.mine.user.firefox.enable {
    programs.firefox = {
      enable = true;
      profiles.default = {
        id = 0;
        isDefault = true;
        settings = {
          "font.name.serif.x-western" = themeConstants.fonts.serif.name;
          "font.name.sans-serif.x-western" = themeConstants.fonts.sansSerif.name;
          "font.name.monospace.x-western" = themeConstants.fonts.monospace.name;
          "font.size.variable.x-western" = ptToPx themeConstants.fonts.sizes.applications;
          "font.size.monospace.x-western" = ptToPx themeConstants.fonts.sizes.terminal;
          "reader.color_scheme" = "custom";
          "reader.custom_colors.background" = "#${colors.base00}";
          "reader.custom_colors.foreground" = "#${colors.base05}";
          "reader.custom_colors.selection-highlight" = "#${colors.base04}";
          "reader.custom_colors.unvisited-links" = "#${colors.base0D}";
          "reader.custom_colors.visited-links" = "#${colors.base0E}";

          # These prefixes are rejected by the Preferences policy allowlist,
          # so they live in user.js (unlocked) instead.
          "app.normandy.enabled" = false;
          "app.normandy.api_url" = "";
          "geo.provider.use_geoclue" = false;
        };
      };
      policies = {
        DisableTelemetry = true; # also covers datareporting.* and the FF136+ usage ping
        DisableFirefoxStudies = true;
        DisableFirefoxAccounts = true;
        SearchSuggestEnabled = false;
        HttpsOnlyMode = "force_enabled";
        DNSOverHTTPS = {
          Enabled = false;
          Locked = true;
        };
        NetworkPrediction = false;
        EnableTrackingProtection = {
          Value = true;
          Locked = true;
          # Strict drives ETP + Total Cookie Protection + fingerprinting
          # protection (FPP) authoritatively; individual privacy.* prefs are
          # both redundant with it and rejected by the Preferences allowlist.
          Category = "strict";
          EmailTracking = true;
        };
        FirefoxSuggest = {
          WebSuggestions = false;
          SponsoredSuggestions = false;
          ImproveSuggest = false;
          Locked = true;
        };
        # External password manager (1Password) handles credentials
        OfferToSaveLogins = false;
        PasswordManagerEnabled = false;
        AutofillAddressEnabled = false;
        AutofillCreditCardEnabled = false;
        DisableFormHistory = true;
        AIControls = {
          Default = false;
        };
        UserMessaging = {
          ExtensionRecommendations = false;
          FeatureRecommendations = false;
          UrlbarInterventions = false;
          SkipOnboarding = true;
          MoreFromMozilla = false;
          FirefoxLabs = false;
          Locked = true;
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
          "{74145f27-f039-47ce-a470-a662b129930a}" = {
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/clearurls/latest.xpi";
            installation_mode = "force_installed";
            private_browsing = true;
          };
          "{d634138d-c276-4fc8-924b-40a0ea21d284}" = {
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi";
            installation_mode = "force_installed";
            private_browsing = true;
          };
        };
        Preferences = {
          "browser.newtabpage.activity-stream.showWeather" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.feeds.topsites" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.feeds.system.topstories" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.showSponsoredTopSites" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.showSponsored" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.feeds.section.highlights" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.feeds.telemetry" = {
            Value = false;
            Status = "locked";
          };
          "browser.newtabpage.activity-stream.telemetry" = {
            Value = false;
            Status = "locked";
          };
          "browser.crashReports.unsubmittedCheck.autoSubmit2" = {
            Value = false;
            Status = "locked";
          };
          "media.peerconnection.ice.default_address_only" = {
            Value = true;
            Status = "locked";
          };
          "media.peerconnection.ice.no_host" = {
            Value = true;
            Status = "locked";
          };

          # No speculative connections to sites that were never clicked
          "network.prefetch-next" = {
            Value = false;
            Status = "locked";
          };
          "network.dns.disablePrefetch" = {
            Value = true;
            Status = "locked";
          };
          "network.dns.disablePrefetchFromHTTPS" = {
            Value = true;
            Status = "locked";
          };
          "network.predictor.enabled" = {
            Value = false;
            Status = "locked";
          };
          "network.http.speculative-parallel-limit" = {
            Value = 0;
            Status = "locked";
          };
          "browser.urlbar.speculativeConnect.enabled" = {
            Value = false;
            Status = "locked";
          };
          "browser.places.speculativeConnect.enabled" = {
            Value = false;
            Status = "locked";
          };

          # PPA ad measurement (default-on since FF128)
          "dom.private-attribution.submission.enabled" = {
            Value = false;
            Status = "locked";
          };
          # Keep Safe Browsing, drop the per-download metadata ping to Google
          "browser.safebrowsing.downloads.remote.enabled" = {
            Value = false;
            Status = "locked";
          };
          "extensions.htmlaboutaddons.recommendations.enabled" = {
            Value = false;
            Status = "locked";
          };
          "browser.discovery.enabled" = {
            Value = false;
            Status = "locked";
          };
        };
      };
    };
  };
}
