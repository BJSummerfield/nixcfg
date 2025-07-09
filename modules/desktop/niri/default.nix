{ pkgs, config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf optionalString;
  inherit (config.mine) user;
  inherit (config) mine;
  cfg = config.mine.desktop.niri;
in
{
  options.mine.desktop.niri = {
    enable = mkEnableOption "Enable niri config";
  };

  config = mkIf cfg.enable {
    programs.niri.enable = true;
    mine.desktop.xwayland-satellite.enable = true;
    mine.apps._1password.silentStartOnGraphical = true;

    home-manager.users.${user.name} = {
      xdg.portal = {
        enable = true;
        extraPortals = with pkgs; [
          xdg-desktop-portal-gnome
          xdg-desktop-portal-gtk
        ];
        config.common.default = [ "gnome" "gtk" ];
      };

      home.packages = with pkgs; [
        brightnessctl
        wl-clipboard
        xwayland-satellite
        nautilus
      ];

      home.file.".config/niri/config.kdl".text = ''
        // https://github.com/YaLTeR/niri/wiki/Configuration:-Overview
        
        environment {
            DISPLAY ":0"
        }

        input {
            touchpad {
                natural-scroll
            }
        }

        ${optionalString (mine.system.hostName == "redtruck") ''
                output "DP-1" {
                mode "3440x1440@174.963"
            }
        ''}

        layout {
            gaps 10
            background-color "transparent"
            center-focused-column "on-overflow"
            preset-column-widths {
                proportion 0.33333
                proportion 0.5
                proportion 0.66667
                proportion 0.8322
            }

            focus-ring {
                width 1
                active-color "#7fc8ff"
                inactive-color "#505050"
            }

            border {
                off
            }
        }
        prefer-no-csd
        screenshot-path "~/Pictures/Screenshots/Screenshot from %Y-%m-%d %H-%M-%S.png"
        
        ${optionalString mine.desktop.swaybg.enable ''
            layer-rule {
                match namespace="^wallpaper$"
                place-within-backdrop true
            }
        ''}

        ${optionalString mine.apps.firefox.enable ''
            window-rule {
                match app-id=r#"firefox$"# title="^Picture-in-Picture$"
                open-floating true
            }
        ''}

        ${optionalString (mine.apps.alacritty.enable && mine.system.hostName == "redtruck") ''
            window-rule {
                match app-id="Alacritty"
                default-column-width {
                    proportion 0.33333
                }
            }
        ''}

        ${optionalString mine.apps._1password.enable '' 
            window-rule {
                match app-id="1Password"
                block-out-from "screen-capture"
            }
        ''}

        binds {
            Mod+Shift+Slash { show-hotkey-overlay; }
            ${optionalString mine.apps.alacritty.enable ''Mod+Return { spawn "alacritty"; }''}
            ${optionalString mine.apps.ghostty.enable ''Mod+Return { spawn "ghostty"; }''}
            ${optionalString mine.desktop.fuzzel.enable ''Mod+Space { spawn "fuzzel"; } ''}
            ${optionalString mine.desktop.hyprlock.enable ''Super+Alt+L { spawn "hyprlock"; }''}
    
            XF86AudioRaiseVolume allow-when-locked=true { spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "0.1+"; }
            XF86AudioLowerVolume allow-when-locked=true { spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "0.1-"; }
            XF86AudioMute        allow-when-locked=true { spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SINK@" "toggle"; }
            XF86AudioMicMute     allow-when-locked=true { spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SOURCE@" "toggle"; }

            XF86MonBrightnessUp   allow-when-locked=true { spawn "brightnessctl" "s" "10%+"; }
            XF86MonBrightnessDown allow-when-locked=true { spawn "brightnessctl" "s" "10%-"; }    

            Mod+Q { close-window; }

            Mod+Left  { focus-column-left; }
            Mod+Down  { focus-window-down; }
            Mod+Up    { focus-window-up; }
            Mod+Right { focus-column-right; }
            Mod+H     { focus-column-left; }
            Mod+J     { focus-window-down; }
            Mod+K     { focus-window-up; }
            Mod+L     { focus-column-right; }

            Mod+Shift+Left  { move-column-left; }
            Mod+Shift+Down  { move-window-down; }
            Mod+Shift+Up    { move-window-up; }
            Mod+Shift+Right { move-column-right; }
            Mod+Shift+H     { move-column-left; }
            Mod+Shift+J     { move-window-down; }
            Mod+Shift+K     { move-window-up; }
            Mod+Shift+L     { move-column-right; }

            Mod+Home { focus-column-first; }
            Mod+End  { focus-column-last; }
            Mod+Ctrl+Home { move-column-to-first; }
            Mod+Ctrl+End  { move-column-to-last; }

            Mod+Ctrl+Left  { focus-monitor-left; }
            Mod+Ctrl+Down  { focus-monitor-down; }
            Mod+Ctrl+Up    { focus-monitor-up; }
            Mod+Ctrl+Right { focus-monitor-right; }
            Mod+Ctrl+H     { focus-monitor-left; }
            Mod+Ctrl+J     { focus-monitor-down; }
            Mod+Ctrl+K     { focus-monitor-up; }
            Mod+Ctrl+L     { focus-monitor-right; }

            Mod+Shift+Ctrl+Left  { move-column-to-monitor-left; }
            Mod+Shift+Ctrl+Down  { move-column-to-monitor-down; }
            Mod+Shift+Ctrl+Up    { move-column-to-monitor-up; }
            Mod+Shift+Ctrl+Right { move-column-to-monitor-right; }
            Mod+Shift+Ctrl+H     { move-column-to-monitor-left; }
            Mod+Shift+Ctrl+J     { move-column-to-monitor-down; }
            Mod+Shift+Ctrl+K     { move-column-to-monitor-up; }
            Mod+Shift+Ctrl+L     { move-column-to-monitor-right; }

            Mod+Page_Down      { focus-workspace-down; }
            Mod+Page_Up        { focus-workspace-up; }
            Mod+U              { focus-workspace-down; }
            Mod+I              { focus-workspace-up; }
            Mod+Ctrl+Page_Down { move-column-to-workspace-down; }
            Mod+Ctrl+Page_Up   { move-column-to-workspace-up; }
            Mod+Ctrl+U         { move-column-to-workspace-down; }
            Mod+Ctrl+I         { move-column-to-workspace-up; }

            Mod+Shift+Page_Down { move-workspace-down; }
            Mod+Shift+Page_Up   { move-workspace-up; }
            Mod+Shift+U         { move-workspace-down; }
            Mod+Shift+I         { move-workspace-up; }
            
            Mod+WheelScrollDown      cooldown-ms=150 { focus-workspace-down; }
            Mod+WheelScrollUp        cooldown-ms=150 { focus-workspace-up; }
            Mod+Ctrl+WheelScrollDown cooldown-ms=150 { move-column-to-workspace-down; }
            Mod+Ctrl+WheelScrollUp   cooldown-ms=150 { move-column-to-workspace-up; }

            Mod+WheelScrollRight      { focus-column-right; }
            Mod+WheelScrollLeft       { focus-column-left; }
            Mod+Ctrl+WheelScrollRight { move-column-right; }
            Mod+Ctrl+WheelScrollLeft  { move-column-left; }

            Mod+Shift+WheelScrollDown      { focus-column-right; }
            Mod+Shift+WheelScrollUp        { focus-column-left; }
            Mod+Ctrl+Shift+WheelScrollDown { move-column-right; }
            Mod+Ctrl+Shift+WheelScrollUp   { move-column-left; }
            
            Mod+1 { focus-workspace 1; }
            Mod+2 { focus-workspace 2; }
            Mod+3 { focus-workspace 3; }
            Mod+4 { focus-workspace 4; }
            Mod+5 { focus-workspace 5; }
            Mod+6 { focus-workspace 6; }
            Mod+7 { focus-workspace 7; }
            Mod+8 { focus-workspace 8; }
            Mod+9 { focus-workspace 9; }
            Mod+Shift+1 { move-column-to-workspace 1; }
            Mod+Shift+2 { move-column-to-workspace 2; }
            Mod+Shift+3 { move-column-to-workspace 3; }
            Mod+Shift+4 { move-column-to-workspace 4; }
            Mod+Shift+5 { move-column-to-workspace 5; }
            Mod+Shift+6 { move-column-to-workspace 6; }
            Mod+Shift+7 { move-column-to-workspace 7; }
            Mod+Shift+8 { move-column-to-workspace 8; }
            Mod+Shift+9 { move-column-to-workspace 9; }
            
            Mod+BracketLeft  { consume-or-expel-window-left; }
            Mod+BracketRight { consume-or-expel-window-right; }
            
            Mod+Comma  { consume-window-into-column; }
           
            Mod+Period { expel-window-from-column; }

            Mod+R { switch-preset-column-width; }
            Mod+Shift+R { switch-preset-window-height; }
            Mod+Ctrl+R { reset-window-height; }
            Mod+F { maximize-column; }
            Mod+Shift+F { fullscreen-window; }

            Mod+Ctrl+F { expand-column-to-available-width; }
            Mod+C { center-column; }

            Mod+Minus { set-column-width "-10%"; }
            Mod+Equal { set-column-width "+10%"; }
            
            Mod+Shift+Minus { set-window-height "-10%"; }
            Mod+Shift+Equal { set-window-height "+10%"; }

            Mod+V       { toggle-window-floating; }
            Mod+Shift+V { switch-focus-between-floating-and-tiling; }

            Mod+W { toggle-column-tabbed-display; }

            Mod+Alt+1 { screenshot; }
            Mod+Alt+2 { screenshot-screen; }
            Mod+Alt+3 { screenshot-window; }
           
            Mod+Escape allow-inhibiting=false { toggle-keyboard-shortcuts-inhibit; }
            Mod+Shift+E { quit; }
            Ctrl+Alt+Delete { quit; }
            Mod+Shift+P { power-off-monitors; }
        }
      '';
    };
  };
}
