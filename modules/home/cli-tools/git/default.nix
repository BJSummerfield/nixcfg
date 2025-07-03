{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.home-manager.git;
in
{
  options.mine.home-manager.git = {
    enable = mkEnableOption "Git config";
  };

  config = mkIf cfg.enable {
    mine.cli-tools.git.enable = true;

    home-manager.users.${user.name} = {
      programs.git = {
        enable = true;
        userName = user.git-user;
        userEmail = user.email;
        extraConfig.init.defaultBranch = "main";
      };
    };
  };
}
