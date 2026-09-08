{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;
  cfg = config.mine.user.paseo-desktop;

  settingsDir =
    if isDarwin then
      "${config.home.homeDirectory}/Library/Application Support/Paseo"
    else
      "${config.xdg.configHome}/Paseo";

  settingsSeed = pkgs.writeText "paseo-desktop-settings.json" (
    builtins.toJSON {
      version = 1;
      settings.daemon.manageBuiltInDaemon = false;
      migrations = {
        legacyRendererSettingsImported = true;
        daemonStopOnQuitDefaultApplied = true;
      };
    }
  );
in
{
  options.mine.user.paseo-desktop.enable =
    mkEnableOption "Paseo desktop app as a client for a remote daemon";

  config = mkIf cfg.enable {
    home.packages = lib.optional isLinux (
      pkgs.symlinkJoin {
        name = "paseo-desktop";
        paths = [ inputs.paseo.packages.${pkgs.stdenv.hostPlatform.system}.desktop ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/paseo-desktop \
            --set PASEO_ELECTRON_USER_DATA_DIR ${settingsDir}
        '';
      }
    );

    home.activation.paseoDesktopSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      settings_dir="${settingsDir}"
      if [ ! -e "$settings_dir/desktop-settings.json" ]; then
        run mkdir -p $VERBOSE_ARG "$settings_dir"
        run install $VERBOSE_ARG -m 0644 ${settingsSeed} \
          "$settings_dir/desktop-settings.json"
      else
        if ! grep -q '"manageBuiltInDaemon"[[:space:]]*:[[:space:]]*false' \
            "$settings_dir/desktop-settings.json"; then
          warnEcho "$settings_dir/desktop-settings.json exists and does not set" \
            "manageBuiltInDaemon to false; disable the built-in daemon in the" \
            "app's settings"
        fi
      fi
    '';
  };
}
