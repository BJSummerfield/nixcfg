{ config, lib, ... }:
let
  cfg = config.features.cli.helix;
in
{
imports = [ ./languages ];
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

  home.sessionVariables = {
    EDITOR = "hx";
  };
}

