{ config, lib, ... }:
{
  imports = [ ./languages ];

  options.mine.user.helix.enable = lib.mkEnableOption "Helix user config";

  config = lib.mkIf config.mine.user.helix.enable {
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

    stylix.targets.helix.enable = false;
  };
}

