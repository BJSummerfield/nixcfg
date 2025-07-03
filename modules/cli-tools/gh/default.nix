{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.gh;
in
{
  options.mine.cli-tools.gh = {
    enable = mkEnableOption "gh config";
  };

  config = mkIf cfg.enable {
    mine.cli-tools.gh.enable = true;
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
