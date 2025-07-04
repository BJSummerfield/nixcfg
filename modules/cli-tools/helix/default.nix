{ config, lib, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.helix;
in
{

  imports = [ ./languages ];

  options.mine.cli-tools.helix = {
    enable = mkEnableOption "Helix user config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.helix = {
        enable = true;
        defaultEditor = true;
        settings = {
          theme = "catppuccin_mocha_transparent";
          editor = {
            line-number = "relative";
            cursorline = true;
            color-modes = true;
            mouse = false;
            end-of-line-diagnostics = "hint";
            cursor-shape = {
              normal = "block";
              insert = "bar";
              select = "underline";
            };
            indent-guides.render = true;
            inline-diagnostics.cursor-line = "hint";
          };
        };
        themes = {
          catppuccin_mocha_transparent = {
            "inherits" = "catppuccin_mocha";
            "ui.background" = { };
          };
        };
      };
      # home.sessionVariables = {
      #   EDITOR = "hx";
      # };
    };
  };
}

