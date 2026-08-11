{
  lib,
  config,
  themeConstants,
  ...
}:
let
  inherit (lib) mkIf mkEnableOption;
  inherit (themeConstants) colors;
in
{
  options.mine.user.lazygit.enable = mkEnableOption "User Lazygit";
  config = mkIf config.mine.user.lazygit.enable {
    programs.lazygit = {
      enable = true;
      settings.gui = {
        language = "en";
        theme = {
          activeBorderColor = [
            "#${colors.base0D}"
            "bold"
          ];
          cherryPickedCommitBgColor = [ "#${colors.base02}" ];
          cherryPickedCommitFgColor = [ "#${colors.base03}" ];
          defaultFgColor = [ "#${colors.base05}" ];
          inactiveBorderColor = [ "#${colors.base03}" ];
          optionsTextColor = [ "#${colors.base06}" ];
          searchingActiveBorderColor = [
            "#${colors.base04}"
            "bold"
          ];
          selectedLineBgColor = [ "#${colors.base03}" ];
          unstagedChangesColor = [ "#${colors.base08}" ];
        };
      };
    };
    home.shellAliases.lg = "lazygit";
  };
}
