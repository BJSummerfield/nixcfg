{ pkgs, config, lib, ... }:
with lib; let
  cfg = config.features.desktop.hyprland;
in
{
  options.features.desktop.hyprland.enable = mkEnableOption "hyprland config";

  config = mkIf cfg.enable {
    wayland.windowManager.hyprland = {
      enable = true;
      package = null;
      settings = {

        # MONITOR
        monitor = ",highrr,auto,auto";

        # PROGRAMS
        "$terminal" = "ghostty";
        "$fileManager" = "dolphin";
        "$menu" = "rofi -show drun";

        # AUTOSTART
        # (Autostart commands from the plain config are commented out.
        #  Uncomment and add commands here if desired.)
        # exec-once = [ "uwsm app -- dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP" ];
        exec-once = [
          "waybar"
        ];
        # ENVIRONMENT VARIABLES
        # (Uncomment and add environment variables if needed.)
        # env = [ "XCURSOR_SIZE,24" "HYPRCURSOR_SIZE,24" ];

        # LOOK AND FEEL: GENERAL
        general = {
          gaps_in = 5;
          gaps_out = 20;
          border_size = 2;
          "col.active_border" = "rgba(33ccffee) rgba(00ff99ee) 45deg";
          "col.inactive_border" = "rgba(595959aa)";
          resize_on_border = false;
          allow_tearing = false;
          layout = "dwindle";
        };

        # LOOK AND FEEL: DECORATION
        decoration = {
          rounding = 10;
          active_opacity = 1.0;
          inactive_opacity = 1.0;
          shadow = {
            enabled = true;
            range = 4;
            render_power = 3;
            color = "rgba(1a1a1aee)";
          };
          blur = {
            enabled = true;
            size = 3;
            passes = 1;
            vibrancy = 0.1696;
          };
        };

        # ANIMATIONS
        animations = {
          enabled = false;
          bezier = [
            "easeOutQuint,0.23,1,0.32,1"
            "easeInOutCubic,0.65,0.05,0.36,1"
            "linear,0,0,1,1"
            "almostLinear,0.5,0.5,0.75,1.0"
            "quick,0.15,0,0.1,1"
          ];
          animation = [
            "global, 1, 10, default"
            "border, 1, 5.39, easeOutQuint"
            "windows, 1, 4.79, easeOutQuint"
            "windowsIn, 1, 4.1, easeOutQuint, popin 87%"
            "windowsOut, 1, 1.49, linear, popin 87%"
            "fadeIn, 1, 1.73, almostLinear"
            "fadeOut, 1, 1.46, almostLinear"
            "fade, 1, 3.03, quick"
            "layers, 1, 3.81, easeOutQuint"
            "layersIn, 1, 4, easeOutQuint, fade"
            "layersOut, 1, 1.5, linear, fade"
            "fadeLayersIn, 1, 1.79, almostLinear"
            "fadeLayersOut, 1, 1.39, almostLinear"
            "workspaces, 1, 1.94, almostLinear, fade"
            "workspacesIn, 1, 1.21, almostLinear, fade"
            "workspacesOut, 1, 1.94, almostLinear, fade"
          ];
        };

        # DWINDLE & MASTER
        dwindle = {
          pseudotile = true;
          preserve_split = true;
        };
        master = {
          new_status = "master";
        };

        # MISCELLANEOUS
        misc = {
          force_default_wallpaper = 0;
          disable_hyprland_logo = true;
          vrr = 2;
        };

        # INPUT: CURSOR
        cursor = {
          no_break_fs_vrr = true;
          no_hardware_cursors = true;
        };

        # INPUT: KEYBOARD & TOUCHPAD
        input = {
          kb_layout = "us";
          kb_variant = "";
          kb_model = "";
          kb_options = "";
          kb_rules = "";
          follow_mouse = 1;
          sensitivity = 0;
          touchpad = {
            natural_scroll = false;
          };
        };

        # GESTURES
        gestures = {
          workspace_swipe = false;
        };

        # PER-DEVICE CONFIG
        device = [
          {
            name = "epic-mouse-v1";
            sensitivity = -0.5;
          }
        ];

        # KEYBINDINGS & MODIFIERS
        "$mainMod" = "SUPER";
        bind = [
          "$mainMod, RETURN, exec, $terminal"
          "$mainMod, Q, killactive,"
          "$mainMod SHIFT, E, exit,"
          "$mainMod, E, exec, $fileManager"
          "$mainMod, SPACE, exec, $menu"
          "$mainMod, J, togglesplit"
          "$mainMod, F, fullscreen"
          "$mainMod, left, movefocus, l"
          "$mainMod, right, movefocus, r"
          "$mainMod, up, movefocus, u"
          "$mainMod, down, movefocus, d"
          "$mainMod, 1, workspace, 1"
          "$mainMod, 2, workspace, 2"
          "$mainMod, 3, workspace, 3"
          "$mainMod, 4, workspace, 4"
          "$mainMod, 5, workspace, 5"
          "$mainMod, 6, workspace, 6"
          "$mainMod, 7, workspace, 7"
          "$mainMod, 8, workspace, 8"
          "$mainMod, 9, workspace, 9"
          "$mainMod, 0, workspace, 10"
          "$mainMod SHIFT, 1, movetoworkspacesilent, 1"
          "$mainMod SHIFT, 2, movetoworkspacesilent, 2"
          "$mainMod SHIFT, 3, movetoworkspacesilent, 3"
          "$mainMod SHIFT, 4, movetoworkspacesilent, 4"
          "$mainMod SHIFT, 5, movetoworkspacesilent, 5"
          "$mainMod SHIFT, 6, movetoworkspacesilent, 6"
          "$mainMod SHIFT, 7, movetoworkspacesilent, 7"
          "$mainMod SHIFT, 8, movetoworkspacesilent, 8"
          "$mainMod SHIFT, 9, movetoworkspacesilent, 9"
          "$mainMod SHIFT, 0, movetoworkspacesilent, 10"
          "$mainMod Shift, left, movewindow, l"
          "$mainMod Shift, right, movewindow, r"
          "$mainMod Shift, up, movewindow, u"
          "$mainMod Shift, down, movewindow, d"
          "CTRL ALT, 1, exec, grim -g \"$(slurp)\" ~/screenshots/screenshot-$(date +%Y-%m-%d-%H%M%S).png"
        ];

        bindm = [
          "$mainMod, mouse:272, movewindow"
          "$mainMod, mouse:273, resizewindow"
        ];

        bindel = [
          ",XF86AudioRaiseVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+"
          ",XF86AudioLowerVolume, exec, wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"
          ",XF86AudioMute, exec, wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"
          ",XF86AudioMicMute, exec, wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"
          ",XF86MonBrightnessUp, exec, brightnessctl s 10%+"
          ",XF86MonBrightnessDown, exec, brightnessctl s 10%-"
        ];

        bindl = [
          ", XF86AudioNext, exec, playerctl next"
          ", XF86AudioPause, exec, playerctl play-pause"
          ", XF86AudioPlay, exec, playerctl play-pause"
          ", XF86AudioPrev, exec, playerctl previous"
        ];

        windowrulev2 = [
          "suppressevent maximize, class:.*"
          "nofocus,class:^$,title:^$,xwayland:1,floating:1,fullscreen:0,pinned:0"
        ];
      };
    };

    programs.waybar = {
      enable = true;
      style = ''
        /* Mocha Palette */
        @define-color base   #1e1e2e;
        @define-color mantle #181825;
        @define-color crust  #11111b;

        @define-color text     #cdd6f4;
        @define-color subtext0 #a6adc8;
        @define-color subtext1 #bac2de;

        @define-color surface0 #313244;
        @define-color surface1 #45475a;
        @define-color surface2 #585b70;

        @define-color overlay0 #6c7086;
        @define-color overlay1 #7f849c;
        @define-color overlay2 #9399b2;

        @define-color blue      #89b4fa;
        @define-color lavender  #b4befe;
        @define-color sapphire  #74c7ec;
        @define-color sky       #89dceb;
        @define-color teal      #94e2d5;
        @define-color green     #a6e3a1;
        @define-color yellow    #f9e2af;
        @define-color peach     #fab387;
        @define-color maroon    #eba0ac;
        @define-color red       #f38ba8;
        @define-color mauve     #cba6f7;
        @define-color pink      #f5c2e7;
        @define-color flamingo  #f2cdcd;
        @define-color rosewater #f5e0dc;

        /* Mocha Styles */
        * {
          font-family: MonaspaceNe Nerd Font;
          font-size: 17px;
          min-height: 0;
        }

        #waybar {
          background: transparent;
          color: @text;
          margin: 5px 5px;
        }

        #workspaces {
          border-radius: 1rem;
          margin: 5px;
          background-color: @surface0;
          margin-left: 1rem;
        }

        #workspaces button {
          color: @lavender;
          border-radius: 1rem;
          padding: 0.4rem;
        }

        #workspaces button.active {
          color: @sky;
          border-radius: 1rem;
        }

        #workspaces button:hover {
          color: @sapphire;
          border-radius: 1rem;
        }

        #custom-music,
        #tray,
        #backlight,
        #clock,
        #battery,
        #pulseaudio,
        #custom-lock,
        #custom-power {
          background-color: @surface0;
          padding: 0.5rem 1rem;
          margin: 5px 0;
        }

        #clock {
          color: @blue;
          border-radius: 0px 1rem 1rem 0px;
          margin-right: 1rem;
        }

        #battery {
          color: @green;
        }

        #battery.charging {
          color: @green;
        }

        #battery.warning:not(.charging) {
          color: @red;
        }

        #backlight {
          color: @yellow;
        }

        #backlight, #battery {
          border-radius: 0;
        }

        #pulseaudio {
          color: @maroon;
          border-radius: 1rem 0px 0px 1rem;
          margin-left: 1rem;
        }

        #custom-music {
          color: @mauve;
          border-radius: 1rem;
        }

        #custom-lock {
          border-radius: 1rem 0px 0px 1rem;
          color: @lavender;
        }

        #custom-power {
          margin-right: 1rem;
          border-radius: 0px 1rem 1rem 0px;
          color: @red;
        }

        #tray {
          margin-right: 1rem;
          border-radius: 1rem;
        }
      '';
      settings = {
        mainbar = {
          layer = "top";
          position = "top";

          "modules-left" = [ "wlr/workspaces" ];
          "modules-center" = [ "custom/music" ];
          "modules-right" = [ "pulseaudio" "backlight" "battery" "clock" "tray" "custom/lock" "custom/power" ];

          "wlr/workspaces" = {
            "disable-scroll" = true;
            "sort-by-name" = true;
            format = " {icon} ";
            "format-icons" = {
              default = "";
            };
          };

          tray = {
            "icon-size" = 21;
            spacing = 10;
          };

          "custom/music" = {
            format = "  {}";
            escape = true;
            interval = 5;
            tooltip = false;
            exec = "playerctl metadata --format='{{ title }}'";
            "on-click" = "playerctl play-pause";
            "max-length" = 50;
          };

          clock = {
            timezone = "Asia/Dubai";
            "tooltip-format" = "<big>{:%Y %B}</big>\n<tt><small>{calendar}</small></tt>";
            "format-alt" = " {:%d/%m/%Y}";
            format = " {:%H:%M}";
          };

          backlight = {
            device = "intel_backlight";
            format = "{icon}";
            "format-icons" = [ "" "" "" "" "" "" "" "" "" ];
          };

          battery = {
            states = {
              warning = 30;
              critical = 15;
            };
            format = "{icon}";
            "format-charging" = "";
            "format-plugged" = "";
            "format-alt" = "{icon}";
            "format-icons" = [ "" "" "" "" "" "" "" "" "" "" "" "" ];
          };

          pulseaudio = {
            format = "{icon} {volume}%";
            "format-muted" = "";
            "format-icons" = {
              default = [ "" "" " " ];
            };
            "on-click" = "pavucontrol";
          };

          "custom/lock" = {
            tooltip = false;
            "on-click" = "sh -c '(sleep 0.5s; swaylock --grace 0)' & disown";
            format = "";
          };

          "custom/power" = {
            tooltip = false;
            "on-click" = "wlogout &";
            format = "襤";
          };
        };
      };
    };

    programs.rofi = {
      enable = true;
      extraConfig = {
        show-icons = true;
        # "display-ssh" = "󰣀 ssh:";
        # "display-run" = "󱓞 run:";
        "display-drun" = "󰣖 drun:";
        # "display-window" = "󱂬 window:";
        # "display-combi" = "󰕘 combi:";
        # "display-filebrowser" = "󰉋 filebrowser:";
      };
      font = "MonaspaceNe Nerd Font 10";
    };

    services.dunst = {
      enable = true;
      settings = {
        global = {
          font = "MonaspaceNe Nerd Font 8";
          word_wrap = true;
          transparency = 10;
        };
      };
    };

    home.packages = with pkgs;
      [
        brightnessctl
        grim
        hyprlock
        qt6.qtwayland
        slurp
        wl-clipboard
      ];
  };
}
