{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.home-manager.cli-tools.zoxide;
in
{
  options.mine.home-manager.cli-tools.zoxide = {
    enable = mkEnableOption "zoxide config";
  };

  config = mkIf cfg.enable {
    mine.home-manager.cli-tools.zoxide.enable = true;
    home-manager.users.${user.name} = {
      programs.zoxide.enable = true;
    };
  };
}
