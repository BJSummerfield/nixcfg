{ pkgs, lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf mkMerge;
  homeConfig = { config, ... }: {
    options.mine.user.git = {
      enable = mkEnableOption "Enable Userspace Git ";
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
  };
in
{
  options.mine.system.git.enable = mkEnableOption "Enable System Git";

  config = {
    environment.systemPackages = mkIf config.mine.system.git.enable [ pkgs.git ];
    home-manager.sharedModules = [ homeConfig ];
  };
}
