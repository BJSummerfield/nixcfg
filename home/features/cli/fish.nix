{ config
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.fish;
in
{
  options.features.cli.fish.enable = mkEnableOption "enable extended fish configuration";

  config = mkIf cfg.enable {
    programs.fish = {
      enable = true;

      # direnv hook fish | source

      interactiveShellInit = ''
        set fish_greeting # Disable greeting
      '';
      loginShellInit = ''
        set fish_greeting # Disable greeting
    
        if test (tty) = "/dev/tty1"
          exec Hyprland &> /dev/null
        end
      '';
      shellAliases = {
        ls = "eza";
        lg = "lazygit";
      };
    };
  };
}
