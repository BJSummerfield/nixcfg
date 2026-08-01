# Spotlight only indexes real bundles in /Applications, not the app
# symlinks home-manager creates, so on darwin the app comes from the
# homebrew cask whenever a user enables alacritty. Home-manager still
# writes the config, which alacritty reads no matter where the app
# came from.
{ lib, config, ... }:
let
  hmUsers = lib.attrValues config.home-manager.users;
  enabled = lib.any (u: u.mine.user.alacritty.enable or false) hmUsers;
in
{
  homebrew.casks = lib.mkIf enabled [ "alacritty" ];

  home-manager.sharedModules = [
    { programs.alacritty.package = null; }
  ];
}
