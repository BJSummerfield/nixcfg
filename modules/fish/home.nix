{ lib, config, themeConstants, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  inherit (themeConstants) colors;
  themeFile = ''
    fish_color_normal ${colors.base05}
    fish_color_command ${colors.base0D}
    fish_color_param ${colors.base0F}
    fish_color_keyword ${colors.base0E}
    fish_color_quote ${colors.base0B}
    fish_color_redirection ${colors.pink}
    fish_color_end ${colors.base09}
    fish_color_comment ${colors.overlay1}
    fish_color_error ${colors.base08}
    fish_color_gray ${colors.base03}
    fish_color_selection --background=${colors.base01}
    fish_color_search_match --background=${colors.base01}
    fish_color_option ${colors.base0B}
    fish_color_operator ${colors.pink}
    fish_color_escape ${colors.maroon}
    fish_color_autosuggestion ${colors.base03}
    fish_color_cancel ${colors.base08}
    fish_color_cwd ${colors.base0A}
    fish_color_user ${colors.base0C}
    fish_color_host ${colors.base0D}
    fish_color_host_remote ${colors.base0B}
    fish_color_status ${colors.base08}
    fish_pager_color_progress ${colors.base03}
    fish_pager_color_prefix ${colors.pink}
    fish_pager_color_completion ${colors.base05}
    fish_pager_color_description ${colors.base03}
  '';
in
{
  options.mine.user.fish.enable = mkEnableOption "User Fish Config";

  config = mkIf config.mine.user.fish.enable {
    xdg.configFile."fish/themes/fish-theme.theme".text = themeFile;
    programs.fish = {
      enable = true;
      interactiveShellInit = ''
        set fish_greeting # Disable greeting
        set -x NIX_PATH nixpkgs=channel:nixos-unstable
        fish_config theme choose fish-theme
      '';
      loginShellInit = ''
        set fish_greeting # Disable greeting
      '';
    };
  };
}
