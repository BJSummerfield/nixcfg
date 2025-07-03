{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.zoxide;
in
{
  options.mine.cli-tools.zoxide = {
    enable = mkEnableOption "zoxide config";
  };

  config = mkIf cfg.enable {
    mine.cli-tools.zoxide.enable = true;
    home-manager.users.${user.name} = {
      programs.zoxide.enable = true;
    };
  };
}
