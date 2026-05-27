{ lib, config, options, ... }:
let
  inherit (lib) mkIf mkEnableOption optionalAttrs;
in
{
  options.mine.user.lazygit.enable = mkEnableOption "User Lazygit";
  config = mkIf config.mine.user.lazygit.enable ({
    programs.lazygit = {
      enable = true;
      settings.gui.language = "en";
    };
    home.shellAliases.lg = "lazygit";
  } // optionalAttrs (options ? stylix) {
    stylix.targets.lazygit.enable = true;
  });
}
