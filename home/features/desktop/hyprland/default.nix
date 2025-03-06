{ pkgs, config, lib, inputs, ... }:
with lib; let
  cfg = config.features.desktop.hyprland;
  stylixModule = inputs.stylix.homeManagerModules.stylix;
in
{
  imports = [
    ./mako.nix
    ./wofi.nix
    ./hyprpaper
    stylixModule
  ];

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
        "$fileManager" = "yazi";
        "$menu" = "wofi --show drun";

        # AUTOSTART
        # (Autostart commands from the plain config are commented out.
        #  Uncomment and add commands here if desired.)
        # exec-once = [ "uwsm app -- dbus-update-activation-environment --systemd WAYLAND_DISPLAY XDG_CURRENT_DESKTOP" ];
        # exec-once = [
        #   "waybar"
        #   "hyprpaper"
        # ];


        # ENVIRONMENT VARIABLES
        # env = [
        #   "XCURSOR_SIZE,24"
        # ];

        # LOOK AND FEEL: GENERAL
        general = {
          gaps_in = 2;
          gaps_out = 10;
          border_size = 1;
          # "col.active_border" = "rgba(33ccffee) rgba(00ff99ee) 45deg";
          # "col.inactive_border" = "rgba(595959aa)";
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
            # color = "rgba(1a1a1aee)";
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
          enabled = true;
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
            natural_scroll = true;
          };
        };

        # GESTURES
        gestures = {
          workspace_swipe = false;
        };

        # PER-DEVICE CONFIG
        # device = [
        #   {
        #     name = "epic-mouse-v1";
        #     sensitivity = -0.5;
        #   }
        # ];

        # KEYBINDINGS & MODIFIERS
        "$mainMod" = "SUPER";
        bind = [
          "$mainMod, RETURN, exec, uwsm app -- $terminal"
          "$mainMod, Q, killactive,"
          "$mainMod SHIFT, E, exit,"
          "$mainMod, E, exec, uwsm app -- $fileManager"
          "$mainMod, SPACE, exec, uwsm app -- $menu"
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


    programs.fish = {
      # loginShellInit = ''
      #   set fish_greeting # Disable greeting

      #   if uwsm check may-start
      #       exec uwsm start hyprland-uwsm.desktop
      #   end
      # '';
    };

    stylix = {
      enable = true;
      image = ./hyprpaper/wallpapers/mountain.jpg;
      base16Scheme = "${pkgs.base16-schemes}/share/themes/catppuccin-mocha.yaml";
      autoEnable = true;
      targets = {
        ghostty.enable = false;
        helix.enable = false;
        fish.enable = false;
      };

      fonts = {
        serif = {
          package = pkgs.nerd-fonts.monaspace;
          name = "MonaspiceNe Nerd Font";
        };

        sansSerif = {
          package = pkgs.nerd-fonts.monaspace;
          name = "MonaspiceNe Nerd Font";
        };

        monospace = {
          package = pkgs.nerd-fonts.monaspace;
          name = "MonaspiceNe Nerd Font";
        };

        emoji = {
          package = pkgs.noto-fonts-emoji;
          name = "Noto Color Emoji";
        };
      };
    };


    home.packages = with pkgs; [
      brightnessctl
      grim
      slurp
      wl-clipboard
    ];
  };
}
