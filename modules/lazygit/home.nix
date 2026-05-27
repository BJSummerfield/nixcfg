{ lib, config, options, ... }:
{
  options.mine.user.lazygit.enable = lib.mkEnableOption "User Lazygit";
  config = lib.mkIf config.mine.user.lazygit.enable (lib.mkMerge [
    {
      programs.lazygit = {
        enable = true;
        settings.gui.language = "en";
      };
      home.shellAliases.lg = "lazygit";
    }
    (lib.mkIf (options ? stylix) {
      stylix.targets.lazygit.enable = true;
    })
  ]);
}
