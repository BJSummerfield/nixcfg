{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  # _1passSigning = config.mine.apps._1password.gitSigning;
in
{
  options.mine.system.git = {
    enable = mkEnableOption "System Git (Package only)";
  };

  config = {
    # System Logic
    environment.systemPackages = mkIf config.mine.system.git.enable [ pkgs.git ];

    # User logic
    home-manager.sharedModules = [
      ({ config, pkgs, lib, ... }: {

        options.mine.user.git = {
          enable = mkEnableOption "User Git Config";
        };

        config = mkIf config.mine.user.git.enable {
          programs.git = {
            enable = true;
            settings = mkMerge [
              { init.defaultBranch = "main"; }
              { }
              # (mkIf _1passSigning {
              #   gpg.ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
              # })
            ];
          };
        };
      })
    ];
  };
}
