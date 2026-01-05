{ lib, config, ... }:
{
  options.mine.user.git = {
    enable = lib.mkEnableOption "Enable Userspace Git ";
  };

  config = lib.mkIf config.mine.user.git.enable {
    programs.git = {
      enable = true;
      settings = {
        init.defaultBranch = "main";
      };
    };
  };
}
