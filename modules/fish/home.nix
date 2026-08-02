{ lib, config, ... }:
let
  inherit (lib) mkEnableOption mkIf;
  theme = import ../theme/constants.nix;
  inherit (theme.colors) base01 base03 base05 base08 base09 base0A base0B base0C base0D base0E base0F overlay1 pink;
  themeFile = ''
    fish_color_normal ${base05}
    fish_color_command ${base0D}
    fish_color_param ${base0F}
    fish_color_keyword ${base0E}
    fish_color_quote ${base0B}
    fish_color_redirection ${pink}
    fish_color_end ${base09}
    fish_color_comment ${overlay1}
    fish_color_error ${base08}
    fish_color_gray ${base03}
    fish_color_selection --background=${base01}
    fish_color_search_match --background=${base01}
    fish_color_option ${base0B}
    fish_color_operator ${pink}
    fish_color_escape eba0ac
    fish_color_autosuggestion ${base03}
    fish_color_cancel ${base08}
    fish_color_cwd ${base0A}
    fish_color_user ${base0C}
    fish_color_host ${base0D}
    fish_color_host_remote ${base0B}
    fish_color_status ${base08}
    fish_pager_color_progress ${base03}
    fish_pager_color_prefix ${pink}
    fish_pager_color_completion ${base05}
    fish_pager_color_description ${base03}
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
