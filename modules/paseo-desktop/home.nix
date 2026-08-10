{ pkgs, lib, config, inputs, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;
  cfg = config.mine.user.paseo-desktop;

  # Electron derives userData from the app name, which main.ts pins to "Paseo".
  settingsDir =
    if isDarwin
    then "${config.home.homeDirectory}/Library/Application Support/Paseo"
    else "${config.xdg.configHome}/Paseo";

  # Partial document: coerceDocument fills omitted keys from upstream defaults.
  # legacyRendererSettingsImported stops a legacy import re-enabling the daemon.
  settingsSeed = pkgs.writeText "paseo-desktop-settings.json" (builtins.toJSON {
    version = 1;
    settings.daemon.manageBuiltInDaemon = false;
    migrations = {
      legacyRendererSettingsImported = true;
      daemonStopOnQuitDefaultApplied = true;
    };
  });
in
{
  options.mine.user.paseo-desktop.enable =
    mkEnableOption "Paseo desktop app as a client for a remote daemon";

  config = mkIf cfg.enable {
    # Darwin installs the app from a homebrew cask instead - see darwin.nix.
    home.packages =
      lib.optional isLinux inputs.paseo.packages.${pkgs.stdenv.hostPlatform.system}.desktop;

    # Seeded only when absent: the app rewrites this file itself, so a home.file
    # symlink would be replaced on its first write and re-clobbered every
    # activation.
    home.activation.paseoDesktopSettings =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        settings_dir="${settingsDir}"
        if [ ! -e "$settings_dir/desktop-settings.json" ]; then
          run mkdir -p $VERBOSE_ARG "$settings_dir"
          run install $VERBOSE_ARG -m 0644 ${settingsSeed} \
            "$settings_dir/desktop-settings.json"
        fi
      '';
  };
}
