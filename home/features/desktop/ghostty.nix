{ ... }: {
  programs.ghostty = {
    enable = true;
    settings = {
      font-family = "MonaspiceNe Nerd Font";
      window-decoration = false;
      theme = "catppuccin-mocha";
      background-opacity = 0.9;
      background-blur-radius = 15;
      font-size = 12;
    };
  };

  home.sessionVariables = {
    TERMINAL = "ghostty";
  };
}
