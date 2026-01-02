{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  cfg = config.mine.cli-tools.lazygit;
in
{
  options.mine.cli-tools.lazygit = {
    enable = mkEnableOption "lazygit config";
  };

  config = mkIf cfg.enable {
    home-manager.sharedModules = [{
      programs = {
        lazygit = {
          enable = true;
          settings = {
            gui.language = "en";
          };
        };
        fish.shellAliases = {
          lg = "lazygit";
        };
      };
    }];
  };
}
