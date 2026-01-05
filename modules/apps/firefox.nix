{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.apps.firefox;
  _1pass = config.mine.apps._1password;
in
{
  options.mine.apps.firefox.enable = mkEnableOption "Enable firefox config";

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.firefox = {
        enable = true;
        policies = {
          DisableTelemetry = true;
          DisableFirefoxStudies = true;
          EnableTrackingProtection = {
            Value = true;
            Locked = true;
            Cryptomining = true;
            Fingerprinting = true;
          };
          DisablePocket = true;

          ExtensionSettings = {
            "*".installation_mode = "blocked"; # blocks all addons except the ones specified below
            # uBlock Origin:
            "uBlock0@raymondhill.net" = {
              install_url = "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
              installation_mode = "force_installed";
              private_browsing = true;
            };
            # Vimium:
            "{d7742d87-e61d-4b78-b8a1-b469842139fa}" = {
              install_url = "https://addons.mozilla.org/firefox/downloads/latest/vimium-ff/latest.xpi";
              installation_mode = "force_installed";
              private_browsing = true;
            };
            # 1Password:
            "{d634138d-c276-4fc8-924b-40a0ea21d284}" = mkIf _1pass.enable {
              install_url = "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi";
              installation_mode = "force_installed";
              private_browsing = true;
            };
          };

          Preferences = {
            "extensions.pocket.enabled" = {
              Value = false;
              Status = "locked";
            };
          };
        };
      };
      stylix.targets.firefox.enable = false;
    };
  };
}
