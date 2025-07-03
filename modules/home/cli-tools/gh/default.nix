{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.home-manager.cli-tools.gh;
in
{
  options.mine.home-manager.cli-tools.gh = {
    enable = mkEnableOption "gh config";
  };

  config = mkIf cfg.enable {
    mine.home-manager.cli-tools.gh.enable = true;
    home-manager.users.${user.name} = {
      programs.gh = {
        enable = true;
        settings = {
          git_protocol = "ssh";
        };
      };
    };
  };
}
