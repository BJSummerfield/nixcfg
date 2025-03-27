{ ... }: {
  programs.alacritty = {
    enable = true;
    settings = {
      font = {
        normal.family = "MonaspiceNe Nerd Font";
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
