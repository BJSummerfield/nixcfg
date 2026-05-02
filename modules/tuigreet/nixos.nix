{ pkgs, lib, config, ... }:
let
  cfg = config.mine.system.tuigreet;
in
{
  options.mine.system.tuigreet.enable = lib.mkEnableOption "tui greet";

  config = lib.mkIf cfg.enable {
    services.greetd = {
      enable = true;
      settings.default_session = {
        command = ''
          ${pkgs.tuigreet}/bin/tuigreet \
            --time \
            --time-format "  %A, %B %d   %I:%M %p  " \
            --remember \
            --remember-user-session \
            --asterisks \
            --asterisks-char "•" \
            --window-padding 4 \
            --container-padding 2 \
            --prompt-padding 1 \
        '';
        user = "greeter";
      };
    };
  };
}
