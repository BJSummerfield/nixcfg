{ ... }:
{
  programs.rofi = {
    enable = true;
    extraConfig = {
      show-icons = true;
      hide-scrollbar = true;
      "display-drun" = "󰣖 drun:";
      font = "MonaspiceNe Nerd Font 8";
      run-command = "uwsm app -- {cmd}";
    };
  };
}
