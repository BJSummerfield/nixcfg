{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.lazygit;
in
{
  options.mine.cli-tools.lazygit = {
    enable = mkEnableOption "lazygit config";
  };

  config = mkIf cfg.enable {
    mine.cli-tools.lazygit.enable = true;
    home-manager.users.${user.name} = {
      programs.lazygit = {
        enable = true;
        settings = {
          gui = {
            language = "en";
          };
        };
      };
    };
  };
}
