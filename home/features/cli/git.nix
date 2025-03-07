{ config
, pkgs
, lib
, ...
}:
with lib; let
  cfg = config.features.cli.git;
in
{
  options.features.cli.git.enable = mkEnableOption "enable extended git configuration";

  config = mkIf cfg.enable {

    programs.gh = {
      enable = true;
      settings = {
        git_protocol = "ssh";
      };
    };

    programs.git = {
      enable = true;
      userName = "BJSummerfield";
      userEmail = "brianjsummerfield@gmail.com";
      extraConfig =
        {
          user.signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP2G3biYuL3iFvhAXYNuVzvRpAQMmFFLek3KFZV4PfDu";
          gpg = {
            ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
            format = "ssh";
          };
          commit.gpgSign = true;
          init.defaultBranch = "main";
        };
    };

    programs.lazygit = {
      enable = true;
      settings = {
        gui = {
          language = "en";
        };
      };
    };
  };
}
