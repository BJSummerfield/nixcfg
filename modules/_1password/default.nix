{ config, lib, ... }:
let
  cfg = config.mine.system.apps._1password;

  # allowedUsers is the names of all users that have 1password enabled
  hmUsers = config.home-manager.users;
  usersWith1Pass = lib.filterAttrs
    (name: userConfig: userConfig.mine.user.apps._1password.enable or false)
    hmUsers;
  allowedUsers = lib.attrNames usersWith1Pass;
in
{
  options.mine.system.apps._1password = {
    enable = lib.mkEnableOption "1Password System Integration";
  };

  config = lib.mkIf cfg.enable {
    nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
      "1password"
      # "1password-gui"
      # "1password-cli"
    ];

    programs._1password.enable = true;

    programs._1password-gui = {
      enable = true;
      polkitPolicyOwners = allowedUsers;
    };

    home-manager.sharedModules = [ ./home.nix ];
  };
}
