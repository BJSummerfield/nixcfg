{ config, lib, ... }:
let
  inherit (lib)
    mkEnableOption
    mkIf
    ;
  cfg = config.mine.system._1password;

  hmUsers = config.home-manager.users;
  usersWith1Pass = lib.filterAttrs (
    _name: userConfig: userConfig.mine.user._1password.enable or false
  ) hmUsers;
  allowedUsers = lib.attrNames usersWith1Pass;
in
{
  options.mine.system._1password = {
    enable = mkEnableOption "1Password System Integration";
  };
  config = mkIf cfg.enable {
    mine.allowedUnfree = [
      "1password"
      "1password-cli"
    ];
    programs._1password.enable = true;
    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = allowedUsers;
    };
  };
}
