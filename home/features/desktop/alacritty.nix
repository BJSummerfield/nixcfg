{ globals, ... }:
{

  programs.alacritty = {
    enable = true;
    settings = {
      font = {
        normal.family = globals.systemFont;
        size = 14;
      };
      window = {
        opacity = 0.8;
        decorations = "buttonless";
        padding = {
          x = 5;
          y = 5;
        };
      };
    };
  };

  home.sessionVariables = {
    TERMINAL = "alacritty";
  };
}
