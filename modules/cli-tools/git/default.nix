{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  inherit (config.mine) user;
  cfg = config.mine.cli-tools.git;
  _1passSigning = config.mine.apps._1password.gitSigning;
in
{
  options.mine.cli-tools.git = {
    enable = mkEnableOption "Git config";
  };

  config = mkIf cfg.enable {
    home-manager.users.${user.name} = {
      programs.git = {
        enable = true;
        userName = "${user.git-user}";
        userEmail = "${user.email}";
        extraConfig = mkMerge [
          {
            init.defaultBranch = "main";
          }
          (mkIf _1passSigning {
            user.signingkey = user.gitSigningKey;
            gpg = {
              ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
              format = "ssh";
            };
            commit.gpgSign = true;
          })
        ];
      };
    };
  };
}
