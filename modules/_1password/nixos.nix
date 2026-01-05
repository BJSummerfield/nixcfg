{ config, lib, ... }:
let
  cfg = config.mine.system._1password;
  # allowedUsers is the names of all users that have 1password enabled
  hmUsers = config.home-manager.users;
  usersWith1Pass = lib.filterAttrs
    (name: userConfig: userConfig.mine.user._1password.enable or false)
    hmUsers;
  allowedUsers = lib.attrNames usersWith1Pass;
in
{
  options.mine.system._1password.enable = lib.mkEnableOption "1Password System Integration";
  config = lib.mkIf cfg.enable {
    mine.system.allowedUnfree = [
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
