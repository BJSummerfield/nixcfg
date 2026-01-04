{ lib, config, ... }:
{
  options.mine.user.git = {
    enable = lib.mkEnableOption "Enable Userspace Git ";
  };

  config = lib.mkIf config.mine.user.git.enable {
    programs.git = {
      enable = true;
      settings = lib.mkMerge [
        { init.defaultBranch = "main"; }
        { }
        # (mkIf _1passSigning {
        #   gpg.ssh.program = "${lib.getExe' pkgs._1password-gui "op-ssh-sign"}";
        # })
      ];
    };
  };
}
