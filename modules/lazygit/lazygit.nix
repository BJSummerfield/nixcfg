{ lib, config, ... }:
{
  options.mine.user.lazygit.enable = lib.mkEnableOption "User Lazygit";

  config = lib.mkIf config.mine.user.lazygit.enable {
    programs.lazygit = {
      enable = true;
      settings.gui.language = "en";
    };
    programs.fish.shellAliases.lg = "lazygit";
  };
}
