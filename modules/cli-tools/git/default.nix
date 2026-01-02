{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  cfg = config.mine.cli-tools.git;
  _1passSigning = config.mine.apps._1password.gitSigning;
in
{
  options.mine.cli-tools.git = {
    enable = mkEnableOption "Git config";
  };

  config = mkIf cfg.enable {
    home-manager.sharedModules = [{
      programs.git = {
        enable = true;
        settings = mkMerge [
          {
            init.defaultBranch = "main";
          }
          (mkIf _1passSigning {
            gpg.ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
          })
        ];
      };
    }];
  };
}
